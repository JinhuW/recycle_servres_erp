// The evaluate and notify stages against real Postgres with stubbed OpenRouter
// and Telegram. These prove the properties the business depends on: every
// target gets exactly one alert, and nothing is lost when a stage fails.

import {createHash} from 'node:crypto';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createConsoleAlertSender, createTelegramAlertSender} from '../src/alerts.ts';
import type {NewPost} from '../src/claims.ts';
import {insertNewPosts} from '../src/claims.ts';
import {createLogger} from '../src/logger.ts';
import {evaluateOnce, type EvaluateDeps} from '../src/loops/evaluate.ts';
import {notifyOnce, type NotifyDeps} from '../src/loops/notify.ts';
import {createRule, updateRule} from '../src/rules.ts';
import {SettingsStore} from '../src/settings.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb('pipeline');
}, 60_000);

afterAll(async () => {
  await db.drop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.sql`DELETE FROM posts`;
  await db.sql`DELETE FROM prompt_versions`;
  await db.sql`UPDATE settings SET value = '["chat-1"]'::jsonb
                WHERE key = 'telegram_chat_ids'`;
  await db.sql`UPDATE settings SET value = '[]'::jsonb WHERE key = 'telegram_dev_chat_ids'`;
  await db.sql`UPDATE settings SET value = '""'::jsonb
                WHERE key IN ('candidate_eval_prompt', 'candidate_llm_model')`;
});

function evaluateDeps(workerId = 'worker-1'): EvaluateDeps {
  return {
    sql: db.sql,
    workerId,
    apiKey: 'test-key',
    settings: new SettingsStore(db.sql, 0),
    alerts: createTelegramAlertSender('bot-token'),
    logger: createLogger(workerId, 'error'),
  };
}

function notifyDeps(workerId = 'worker-1'): NotifyDeps {
  return {
    sql: db.sql,
    workerId,
    alerts: createTelegramAlertSender('bot-token'),
    settings: new SettingsStore(db.sql, 0),
    logger: createLogger(workerId, 'error'),
  };
}

function post(overrides: Partial<NewPost> = {}): NewPost {
  return {
    redditId: 't3_a',
    subreddit: 'homelabsales',
    title: '[FS][USA-CO] Dell R730xd',
    selftext: 'Selling a Dell R730xd, $650 shipped.',
    author: 'seller',
    flair: null,
    url: 'https://www.reddit.com/r/homelabsales/comments/a/fs/',
    postedAt: new Date(),
    ...overrides,
  };
}

function stubVerdict(verdict: Record<string, unknown>) {
  const spy = vi.fn().mockImplementation(async () => new Response(
    JSON.stringify({choices: [{message: {content: JSON.stringify(verdict)}}]}),
    {status: 200},
  ));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function stubTelegram(ok = true) {
  const spy = vi.fn().mockImplementation(async () => new Response(
    JSON.stringify(ok ? {ok: true} : {ok: false, description: 'chat not found'}),
    {status: ok ? 200 : 400},
  ));
  vi.stubGlobal('fetch', spy);
  return spy;
}

type Verdict = Record<string, unknown> | 'fail';

/**
 * Stubs OpenRouter and Telegram together, as a candidate trial needs both in
 * one iteration. The live and candidate prompts are told apart by the system
 * prompt; every Telegram send gets a fresh message id, as the real API does.
 */
function stubUpstreams(options: {
  live: Verdict;
  candidate?: Verdict;
  chatFails?: (chatId: string) => boolean;
}) {
  let nextMessageId = 100;
  const spy = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.includes('openrouter')) {
      const systemPrompt = body.messages[0].content as string;
      const verdict = systemPrompt.startsWith(CANDIDATE) ? options.candidate : options.live;
      if (verdict === undefined || verdict === 'fail') {
        return new Response('upstream unavailable', {status: 502});
      }
      return new Response(
        JSON.stringify({choices: [{message: {content: JSON.stringify(verdict)}}]}),
        {status: 200},
      );
    }
    if (options.chatFails?.(String(body.chat_id))) {
      return new Response(JSON.stringify({ok: false, description: 'chat not found'}), {status: 400});
    }
    return new Response(
      JSON.stringify({ok: true, result: {message_id: nextMessageId++}}),
      {status: 200},
    );
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const CANDIDATE = 'CANDIDATE: judge bulk lots only.';
const TARGET = {is_target: true, summary: 'Lot of 21 SSDs.', price: '$2300', reasoning: '21 SSDs.'};
const REJECT = {is_target: false, summary: 'Two SSDs.', price: null, reasoning: 'Only 2 SSDs.'};

function telegramCalls(spy: ReturnType<typeof vi.fn>): Array<{chat_id: string; text: string}> {
  return spy.mock.calls
    .filter(([url]) => String(url).includes('api.telegram.org'))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await db.sql`UPDATE settings SET value = ${db.sql.json(value as never)} WHERE key = ${key}`;
}

async function messagesOf(redditId: string): Promise<Array<[string, string]>> {
  const rows = await db.sql<Array<{chat_id: string; audience: string}>>`
    SELECT chat_id, audience FROM alert_messages WHERE reddit_id = ${redditId}
     ORDER BY audience, chat_id`;
  return rows.map((r) => [r.chat_id, r.audience]);
}

async function statusOf(redditId: string): Promise<string> {
  const [row] = await db.sql<Array<{status: string}>>`
    SELECT status FROM posts WHERE reddit_id = ${redditId}`;
  return row?.status ?? 'missing';
}

describe('evaluateOnce', () => {
  it('queues a target for alerting and stores its summary', async () => {
    await insertNewPosts(db.sql, [post()]);
    stubVerdict({
      is_target: true,
      summary: 'Dell R730xd, $650 shipped, Colorado.',
      price: '$650 shipped',
      reasoning: 'Server for sale.',
    });

    expect(await evaluateOnce(evaluateDeps())).toBe(true);

    const [row] = await db.sql<Array<{
      status: string; is_target: boolean; llm_summary: string; llm_price: string;
    }>>`SELECT status, is_target, llm_summary, llm_price FROM posts WHERE reddit_id = 't3_a'`;
    expect(row).toMatchObject({
      status: 'target',
      is_target: true,
      llm_summary: 'Dell R730xd, $650 shipped, Colorado.',
      llm_price: '$650 shipped',
    });
  });

  it('appends enabled rules to the evaluator prompt and leaves disabled ones out', async () => {
    await db.sql`DELETE FROM rules`;
    await createRule(db.sql, {name: 'EPYC lots', prompt: 'Alert on bulk EPYC CPU lots.'});
    const off = await createRule(db.sql, {name: 'Off', prompt: 'Never mention this.'});
    await updateRule(db.sql, off.id, {enabled: false});
    await insertNewPosts(db.sql, [post()]);
    const spy = stubVerdict({is_target: false, summary: 's', price: null, reasoning: 'r'});

    await evaluateOnce(evaluateDeps());

    const request = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string) as {
      messages: Array<{role: string; content: string}>;
    };
    const systemPrompt = request.messages[0]!.content;
    expect(systemPrompt).toContain('EPYC lots: Alert on bulk EPYC CPU lots.');
    expect(systemPrompt).not.toContain('Never mention this.');
  });

  it('drops a post the model rejected', async () => {
    await insertNewPosts(db.sql, [post()]);
    stubVerdict({is_target: false, summary: 'Asking for advice.', price: null, reasoning: 'r'});

    await evaluateOnce(evaluateDeps());

    expect(await statusOf('t3_a')).toBe('rejected');
    const [row] = await db.sql<Array<{reject_reason: string}>>`
      SELECT reject_reason FROM posts WHERE reddit_id = 't3_a'`;
    expect(row?.reject_reason).toBe('not_target');
  });

  it('does nothing when the queue is empty', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    expect(await evaluateOnce(evaluateDeps())).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('spends no API call on a post that went stale while queued', async () => {
    await insertNewPosts(db.sql, [post({postedAt: new Date(Date.now() - 72 * 3600_000)})]);
    const spy = stubVerdict({is_target: true, summary: 's', price: null, reasoning: 'r'});

    await evaluateOnce(evaluateDeps());

    expect(spy).not.toHaveBeenCalled();
    expect(await statusOf('t3_a')).toBe('rejected');
    const [row] = await db.sql<Array<{reject_reason: string}>>`
      SELECT reject_reason FROM posts WHERE reddit_id = 't3_a'`;
    expect(row?.reject_reason).toBe('too_old');
  });

  it('keeps a post for retry when the model call fails', async () => {
    await insertNewPosts(db.sql, [post()]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));

    await evaluateOnce(evaluateDeps());

    expect(await statusOf('t3_a')).toBe('new');
    const [row] = await db.sql<Array<{attempts: number; claimed_by: string | null}>>`
      SELECT attempts, claimed_by FROM posts WHERE reddit_id = 't3_a'`;
    expect(row?.attempts).toBe(1);
    expect(row?.claimed_by).toBeNull();
  });

  it('evaluates each post once even with two workers running', async () => {
    await insertNewPosts(db.sql, [
      post({redditId: 't3_1'}), post({redditId: 't3_2'}), post({redditId: 't3_3'}),
    ]);
    const spy = stubVerdict({is_target: true, summary: 's', price: null, reasoning: 'r'});

    await Promise.all([
      evaluateOnce(evaluateDeps('worker-1')),
      evaluateOnce(evaluateDeps('worker-2')),
    ]);

    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe('notifyOnce', () => {
  async function seedTarget(redditId = 't3_a'): Promise<void> {
    await insertNewPosts(db.sql, [post({redditId})]);
    await db.sql`
      UPDATE posts SET status = 'target', is_target = TRUE,
                       llm_summary = 'Dell R730xd, $650 shipped.', llm_price = '$650'
       WHERE reddit_id = ${redditId}`;
  }

  it('sends the summary and the link, then marks the post notified', async () => {
    await seedTarget();
    const spy = stubTelegram();

    expect(await notifyOnce(notifyDeps())).toBe(true);

    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toContain('Dell R730xd, $650 shipped.');
    expect(body.text).toContain('https://www.reddit.com/r/homelabsales/comments/a/fs/');
    expect(await statusOf('t3_a')).toBe('notified');
  });

  it('never alerts the same post twice, even across workers', async () => {
    await seedTarget();
    const spy = stubTelegram();

    await Promise.all([notifyOnce(notifyDeps('worker-1')), notifyOnce(notifyDeps('worker-2'))]);
    await notifyOnce(notifyDeps('worker-1'));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ignores posts that were never marked as targets', async () => {
    await insertNewPosts(db.sql, [post()]);
    const spy = stubTelegram();

    expect(await notifyOnce(notifyDeps())).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('holds targets until a recipient is configured, rather than dropping them', async () => {
    await seedTarget();
    await db.sql`UPDATE settings SET value = '[]'::jsonb WHERE key = 'telegram_chat_ids'`;
    const spy = stubTelegram();

    expect(await notifyOnce(notifyDeps())).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(await statusOf('t3_a')).toBe('target');

    await db.sql`UPDATE settings SET value = '["chat-1"]'::jsonb
                  WHERE key = 'telegram_chat_ids'`;
    expect(await notifyOnce(notifyDeps())).toBe(true);
    expect(await statusOf('t3_a')).toBe('notified');
  });

  it('prints alerts and marks them notified when the transport is the console', async () => {
    await seedTarget();
    await db.sql`UPDATE settings SET value = '[]'::jsonb WHERE key = 'telegram_chat_ids'`;
    const telegram = stubTelegram();
    const printed: string[] = [];

    expect(await notifyOnce({
      ...notifyDeps(),
      alerts: createConsoleAlertSender((text) => printed.push(text)),
    })).toBe(true);

    // The console transport needs no recipients and must not touch Telegram.
    expect(telegram).not.toHaveBeenCalled();
    expect(printed[0]).toContain('Dell R730xd, $650 shipped.');
    expect(printed[0]).toContain('https://www.reddit.com/r/homelabsales/comments/a/fs/');
    // Plain text, not the HTML Telegram would receive.
    expect(printed[0]).not.toContain('<b>');
    expect(await statusOf('t3_a')).toBe('notified');
  });

  it('retries a target when every chat rejected the message', async () => {
    await seedTarget();
    stubTelegram(false);

    await notifyOnce(notifyDeps());

    expect(await statusOf('t3_a')).toBe('target');
    const [row] = await db.sql<Array<{attempts: number}>>`
      SELECT attempts FROM posts WHERE reddit_id = 't3_a'`;
    expect(row?.attempts).toBe(1);
  });

  it('counts a partial delivery as sent so the reached chats are not spammed', async () => {
    await seedTarget();
    await db.sql`UPDATE settings SET value = '["good","bad"]'::jsonb
                  WHERE key = 'telegram_chat_ids'`;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ok: true}), {status: 200}))
      .mockImplementationOnce(async () => new Response(
        JSON.stringify({ok: false, description: 'chat not found'}), {status: 400},
      )));

    await notifyOnce(notifyDeps());

    expect(await statusOf('t3_a')).toBe('notified');
  });
});

describe('prompt versions', () => {
  it('records which prompt judged each post, and reuses the version while it is unchanged', async () => {
    await db.sql`DELETE FROM rules`;
    stubUpstreams({live: REJECT});
    await insertNewPosts(db.sql, [post({redditId: 't3_1'})]);
    await evaluateOnce(evaluateDeps());
    await insertNewPosts(db.sql, [post({redditId: 't3_2'})]);
    await evaluateOnce(evaluateDeps());

    await createRule(db.sql, {name: 'EPYC lots', prompt: 'Alert on bulk EPYC CPU lots.'});
    await insertNewPosts(db.sql, [post({redditId: 't3_3'})]);
    await evaluateOnce(evaluateDeps());

    const rows = await db.sql<Array<{reddit_id: string; prompt_version_id: number}>>`
      SELECT reddit_id, prompt_version_id FROM posts ORDER BY reddit_id`;
    const [first, second, third] = rows.map((r) => r.prompt_version_id);
    expect(first).toBe(second);
    expect(third).not.toBe(first);

    const [version] = await db.sql<Array<{model: string; system_prompt: string}>>`
      SELECT model, system_prompt FROM prompt_versions WHERE id = ${third!}`;
    expect(version?.model).toBe('openai/gpt-4o-mini');
    expect(version?.system_prompt).toContain('EPYC lots: Alert on bulk EPYC CPU lots.');
    await db.sql`DELETE FROM rules`;
  });

  it('numbers versions in the order prompts first appear, however many batches run', async () => {
    await db.sql`DELETE FROM rules`;
    stubUpstreams({live: REJECT});
    for (const id of ['t3_1', 't3_2', 't3_3']) {
      await insertNewPosts(db.sql, [post({redditId: id})]);
      await evaluateOnce(evaluateDeps());
    }
    // A prompt that first appears after many batches gets the next number.
    await createRule(db.sql, {name: 'EPYC lots', prompt: 'Alert on bulk EPYC CPU lots.'});
    await insertNewPosts(db.sql, [post({redditId: 't3_4'})]);
    await evaluateOnce(evaluateDeps());

    const versions = await db.sql<Array<{id: number}>>`SELECT id FROM prompt_versions ORDER BY id`;
    expect(versions).toHaveLength(2);
    expect(versions[1]!.id - versions[0]!.id).toBe(1);
    await db.sql`DELETE FROM rules`;
  });

  it('records the response schema, and never reuses a version made under another one', async () => {
    await db.sql`DELETE FROM rules`;
    stubUpstreams({live: REJECT});
    const settings = await new SettingsStore(db.sql, 0).get();
    // The same wording as live, stored the way versions were before the
    // schema joined their identity.
    const old = createHash('sha256')
      .update(`${settings.llmModel}\0${settings.evalPrompt}`).digest('hex');
    await db.sql`
      INSERT INTO prompt_versions (hash, model, system_prompt)
      VALUES (${old}, ${settings.llmModel}, ${settings.evalPrompt})`;

    await insertNewPosts(db.sql, [post()]);
    await evaluateOnce(evaluateDeps());

    const rows = await db.sql<Array<{response_schema: string; used: boolean}>>`
      SELECT v.response_schema, EXISTS (SELECT 1 FROM posts p WHERE p.prompt_version_id = v.id) AS used
        FROM prompt_versions v ORDER BY v.id`;
    expect(rows).toEqual([
      {response_schema: 'verdict-first', used: false},
      {response_schema: 'reasoning-first', used: true},
    ]);
  });

  it('leaves a post rejected for age unversioned, since no prompt judged it', async () => {
    await insertNewPosts(db.sql, [post({postedAt: new Date(Date.now() - 72 * 3600_000)})]);
    stubUpstreams({live: TARGET});

    await evaluateOnce(evaluateDeps());

    const [row] = await db.sql<Array<{prompt_version_id: number | null}>>`
      SELECT prompt_version_id FROM posts WHERE reddit_id = 't3_a'`;
    expect(row?.prompt_version_id).toBeNull();
  });
});

describe('dev chat reviews', () => {
  it('sends every live alert to the dev chat too, with the reasoning, and records both', async () => {
    await setSetting('telegram_dev_chat_ids', ['dev-1']);
    await insertNewPosts(db.sql, [post()]);
    const spy = stubUpstreams({live: TARGET});

    await evaluateOnce(evaluateDeps());
    await notifyOnce(notifyDeps());

    const [buyers, review] = telegramCalls(spy);
    expect(buyers?.chat_id).toBe('chat-1');
    expect(buyers?.text).not.toContain('Review');
    expect(review?.chat_id).toBe('dev-1');
    expect(review?.text).toContain('flagged by live');
    expect(review?.text).toContain('21 SSDs.');
    expect(await messagesOf('t3_a')).toEqual([['chat-1', 'buyers'], ['dev-1', 'dev']]);
  });

  it('keeps the buyer alert when the review cannot be delivered', async () => {
    await setSetting('telegram_dev_chat_ids', ['dev-1']);
    await insertNewPosts(db.sql, [post()]);
    stubUpstreams({live: TARGET, chatFails: (chat) => chat === 'dev-1'});

    await evaluateOnce(evaluateDeps());
    await notifyOnce(notifyDeps());

    expect(await statusOf('t3_a')).toBe('notified');
    expect(await messagesOf('t3_a')).toEqual([['chat-1', 'buyers']]);
  });

  it('sends no review when no dev chat is configured', async () => {
    await setSetting('candidate_eval_prompt', CANDIDATE);
    await insertNewPosts(db.sql, [post()]);
    const spy = stubUpstreams({live: REJECT, candidate: TARGET});

    await evaluateOnce(evaluateDeps());

    expect(telegramCalls(spy)).toEqual([]);
  });
});

describe('candidate prompt trial', () => {
  it('judges each post with the candidate too, without changing what buyers get', async () => {
    await setSetting('candidate_eval_prompt', CANDIDATE);
    await setSetting('telegram_dev_chat_ids', ['dev-1']);
    await insertNewPosts(db.sql, [post()]);
    const spy = stubUpstreams({live: TARGET, candidate: REJECT});

    await evaluateOnce(evaluateDeps());
    expect(await statusOf('t3_a')).toBe('target');
    const [verdict] = await db.sql<Array<{is_target: boolean; reasoning: string; model: string}>>`
      SELECT cv.is_target, cv.reasoning, pv.model FROM candidate_verdicts cv
        JOIN prompt_versions pv ON pv.id = cv.prompt_version_id WHERE cv.reddit_id = 't3_a'`;
    expect(verdict).toEqual({is_target: false, reasoning: 'Only 2 SSDs.', model: 'openai/gpt-4o-mini'});

    await notifyOnce(notifyDeps());
    const [buyers, review] = telegramCalls(spy);
    expect(buyers?.chat_id).toBe('chat-1');
    expect(review?.text).toContain('<b>Candidate</b>');
    expect(review?.text).toContain('❌ no alert');
  });

  it('runs the candidate on its own model when one is set', async () => {
    await setSetting('candidate_eval_prompt', CANDIDATE);
    await setSetting('candidate_llm_model', 'anthropic/claude-haiku-5.5');
    await insertNewPosts(db.sql, [post()]);
    const spy = stubUpstreams({live: REJECT, candidate: REJECT});

    await evaluateOnce(evaluateDeps());

    const models = spy.mock.calls.map(([, init]) =>
      JSON.parse((init as RequestInit).body as string).model as string);
    expect(models).toEqual(['openai/gpt-4o-mini', 'anthropic/claude-haiku-5.5']);
  });

  it('sends a post only the candidate flagged to the dev chat alone, never to buyers', async () => {
    await setSetting('candidate_eval_prompt', CANDIDATE);
    await setSetting('telegram_dev_chat_ids', ['dev-1']);
    await insertNewPosts(db.sql, [post()]);
    const spy = stubUpstreams({live: REJECT, candidate: TARGET});

    await evaluateOnce(evaluateDeps());

    expect(await statusOf('t3_a')).toBe('rejected');
    const calls = telegramCalls(spy);
    expect(calls.map((c) => c.chat_id)).toEqual(['dev-1']);
    expect(calls[0]?.text).toContain('flagged by candidate');
    expect(calls[0]?.text).toContain('Lot of 21 SSDs.');
    expect(await messagesOf('t3_a')).toEqual([['dev-1', 'dev']]);

    expect(await notifyOnce(notifyDeps())).toBe(false);
    expect(telegramCalls(spy)).toHaveLength(1);
  });

  it('reviews each candidate-only post once even with two workers running', async () => {
    await setSetting('candidate_eval_prompt', CANDIDATE);
    await setSetting('telegram_dev_chat_ids', ['dev-1']);
    await insertNewPosts(db.sql, [
      post({redditId: 't3_1'}), post({redditId: 't3_2'}), post({redditId: 't3_3'}),
    ]);
    const spy = stubUpstreams({live: REJECT, candidate: TARGET});

    await Promise.all([
      evaluateOnce(evaluateDeps('worker-1')),
      evaluateOnce(evaluateDeps('worker-2')),
    ]);

    expect(telegramCalls(spy)).toHaveLength(3);
    const [row] = await db.sql<Array<{n: number}>>`
      SELECT COUNT(DISTINCT reddit_id)::int AS n FROM alert_messages WHERE audience = 'dev'`;
    expect(row?.n).toBe(3);
  });

  it('keeps the live verdict when the candidate call fails', async () => {
    await setSetting('candidate_eval_prompt', CANDIDATE);
    await insertNewPosts(db.sql, [post()]);
    stubUpstreams({live: TARGET, candidate: 'fail'});

    await evaluateOnce(evaluateDeps());

    expect(await statusOf('t3_a')).toBe('target');
    const [row] = await db.sql<Array<{n: number}>>`
      SELECT COUNT(*)::int AS n FROM candidate_verdicts`;
    expect(row?.n).toBe(0);
  });
});

describe('full pipeline', () => {
  it('carries a for-sale post from discovery to a single alert', async () => {
    await insertNewPosts(db.sql, [post()]);

    stubVerdict({
      is_target: true,
      summary: 'Dell R730xd, 256GB ECC, $650 shipped from Colorado.',
      price: '$650 shipped',
      reasoning: 'Server hardware for sale.',
    });
    await evaluateOnce(evaluateDeps());

    const telegram = stubTelegram();
    await notifyOnce(notifyDeps());

    expect(telegram).toHaveBeenCalledTimes(1);
    const body = JSON.parse((telegram.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toContain('r/homelabsales');
    expect(body.text).toContain('Dell R730xd, 256GB ECC, $650 shipped from Colorado.');
    expect(body.text).toContain('https://www.reddit.com/r/homelabsales/comments/a/fs/');
    expect(await statusOf('t3_a')).toBe('notified');
  });
});
