// The evaluate and notify stages against real Postgres with stubbed OpenRouter
// and Telegram. These prove the properties the business depends on: every
// target gets exactly one alert, and nothing is lost when a stage fails.

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import type {NewPost} from '../src/claims.ts';
import {insertNewPosts} from '../src/claims.ts';
import {createLogger} from '../src/logger.ts';
import {evaluateOnce, type EvaluateDeps} from '../src/loops/evaluate.ts';
import {notifyOnce, type NotifyDeps} from '../src/loops/notify.ts';
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
  await db.sql`UPDATE settings SET value = '["chat-1"]'::jsonb
                WHERE key = 'telegram_chat_ids'`;
});

function evaluateDeps(workerId = 'worker-1'): EvaluateDeps {
  return {
    sql: db.sql,
    workerId,
    apiKey: 'test-key',
    settings: new SettingsStore(db.sql, 0),
    logger: createLogger(workerId, 'error'),
  };
}

function notifyDeps(workerId = 'worker-1'): NotifyDeps {
  return {
    sql: db.sql,
    workerId,
    botToken: 'bot-token',
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
