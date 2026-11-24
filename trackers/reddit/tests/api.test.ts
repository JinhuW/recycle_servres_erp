import type {Hono} from 'hono';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApi} from '../src/api.ts';
import {importEnvKeys, KeyStore} from '../src/llm/keys.ts';
import {createLogger} from '../src/logger.ts';
import {candidateConfig, ensurePromptVersion, liveConfig} from '../src/prompts.ts';
import {SettingsStore} from '../src/settings.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

const TOKEN = 'test-token';
let db: TestDb;
let app: Hono;
let keys: KeyStore;

beforeAll(async () => {
  db = await createTestDb('api');
  // A long TTL, so a test sees a stale read unless the route invalidates.
  keys = new KeyStore(db.sql, 3_600_000);
  app = createApi({
    sql: db.sql,
    settings: new SettingsStore(db.sql, 0),
    keys,
    botToken: 'bot-token',
    apiToken: TOKEN,
    workerId: 'test-worker',
    startedAt: Date.now(),
  });
}, 60_000);

afterAll(async () => {
  await db.drop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.sql`DELETE FROM posts`;
  await db.sql`DELETE FROM subreddits`;
  await db.sql`DELETE FROM workers`;
  await db.sql`DELETE FROM rules`;
  await db.sql`DELETE FROM llm_keys`;
  await db.sql`DELETE FROM llm_keys_env_imported`;
  // A stored OpenRouter key, so OpenRouter model ids pass the key check.
  await db.sql`INSERT INTO llm_keys (provider, api_key) VALUES ('openrouter', 'stored-or-key')`;
  keys.invalidate();
  await db.sql`UPDATE settings SET value = '[]'::jsonb WHERE key = 'telegram_chat_ids'`;
});

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function seedTarget(id: string, summary: string): Promise<void> {
  await db.sql`
    INSERT INTO posts (reddit_id, subreddit, title, url, posted_at, status,
                       is_target, llm_summary, llm_price)
    VALUES (${id}, 'homelabsales', 'Dell R730', ${`https://reddit.com/${id}`},
            NOW(), 'notified', TRUE, ${summary}, '$650')`;
}

describe('authentication', () => {
  it('rejects a request with no token', async () => {
    const res = await app.request('/api/matches');

    expect(res.status).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const res = await app.request('/api/matches', {
      headers: {Authorization: 'Bearer nope'},
    });

    expect(res.status).toBe(401);
  });

  it('leaves health open so uptime checks work', async () => {
    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ok: true, workerId: 'test-worker'});
  });
});

describe('GET /api/matches', () => {
  it('returns the item list: summary, price and post link', async () => {
    await seedTarget('t3_a', 'Dell R730xd with 256GB ECC.');

    const body = await (await request('/api/matches')).json() as {
      count: number;
      matches: Array<{summary: string; url: string; price: string}>;
    };

    expect(body.count).toBe(1);
    expect(body.matches[0]).toMatchObject({
      summary: 'Dell R730xd with 256GB ECC.',
      price: '$650',
      url: 'https://reddit.com/t3_a',
    });
  });

  it('leaves out a cross-post copy buyers got through its twin', async () => {
    await seedTarget('t3_a', 'Lot of RAM');
    await seedTarget('t3_b', 'Lot of RAM');
    await db.sql`UPDATE posts SET status = 'duplicate', duplicate_of = 't3_a' WHERE reddit_id = 't3_b'`;

    const body = await (await request('/api/matches')).json() as {matches: Array<{redditId: string}>};

    expect(body.matches.map((m) => m.redditId)).toEqual(['t3_a']);
  });

  it('leaves out posts the LLM rejected', async () => {
    await db.sql`
      INSERT INTO posts (reddit_id, subreddit, title, url, posted_at, status, is_target)
      VALUES ('t3_no', 'homelab', 'Advice needed', 'https://x', NOW(), 'rejected', FALSE)`;

    const body = await (await request('/api/matches')).json() as {count: number};

    expect(body.count).toBe(0);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 5; i++) await seedTarget(`t3_${i}`, `item ${i}`);

    const body = await (await request('/api/matches?limit=2')).json() as {count: number};

    expect(body.count).toBe(2);
  });

  it('filters by discovery time', async () => {
    await seedTarget('t3_old', 'old item');
    await db.sql`UPDATE posts SET discovered_at = NOW() - INTERVAL '10 days'`;
    await seedTarget('t3_new', 'new item');

    const since = new Date(Date.now() - 86_400_000).toISOString();
    const body = await (await request(`/api/matches?since=${since}`)).json() as {
      count: number;
      matches: Array<{redditId: string}>;
    };

    expect(body.count).toBe(1);
    expect(body.matches[0]?.redditId).toBe('t3_new');
  });

  it('rejects an unparseable since value', async () => {
    expect((await request('/api/matches?since=yesterday')).status).toBe(400);
  });
});

describe('subreddit management', () => {
  it('adds a subreddit the workers will start polling', async () => {
    const res = await request('/api/subreddits', {
      method: 'POST',
      body: JSON.stringify({name: 'buildapcsales', pollIntervalSeconds: 120}),
    });

    expect(res.status).toBe(201);
    const [row] = await db.sql<Array<{name: string; poll_interval_seconds: number}>>`
      SELECT name, poll_interval_seconds FROM subreddits`;
    expect(row).toMatchObject({name: 'buildapcsales', poll_interval_seconds: 120});
  });

  it('accepts a name written with the r/ prefix', async () => {
    await request('/api/subreddits', {
      method: 'POST',
      body: JSON.stringify({name: 'r/homelabsales'}),
    });

    const [row] = await db.sql<Array<{name: string}>>`SELECT name FROM subreddits`;
    expect(row?.name).toBe('homelabsales');
  });

  it('refuses a polling interval below the floor', async () => {
    const res = await request('/api/subreddits', {
      method: 'POST',
      body: JSON.stringify({name: 'homelab', pollIntervalSeconds: 5}),
    });

    expect(res.status).toBe(400);
  });

  it('refuses a name that is not a subreddit', async () => {
    const res = await request('/api/subreddits', {
      method: 'POST',
      body: JSON.stringify({name: 'not a subreddit!'}),
    });

    expect(res.status).toBe(400);
  });

  it('re-enables an existing subreddit rather than erroring', async () => {
    await db.sql`INSERT INTO subreddits (name, enabled) VALUES ('homelab', FALSE)`;

    const res = await request('/api/subreddits', {
      method: 'POST',
      body: JSON.stringify({name: 'homelab'}),
    });

    expect(res.status).toBe(201);
    const [row] = await db.sql<Array<{enabled: boolean}>>`
      SELECT enabled FROM subreddits WHERE name = 'homelab'`;
    expect(row?.enabled).toBe(true);
  });

  it('disables a subreddit without deleting its history', async () => {
    await db.sql`INSERT INTO subreddits (name) VALUES ('homelab')`;

    const res = await request('/api/subreddits/homelab', {
      method: 'PATCH',
      body: JSON.stringify({enabled: false}),
    });

    expect(res.status).toBe(200);
    const [row] = await db.sql<Array<{enabled: boolean}>>`
      SELECT enabled FROM subreddits WHERE name = 'homelab'`;
    expect(row?.enabled).toBe(false);
  });

  it('404s when patching a subreddit that is not watched', async () => {
    const res = await request('/api/subreddits/nosuchsub', {
      method: 'PATCH',
      body: JSON.stringify({enabled: false}),
    });

    expect(res.status).toBe(404);
  });

  it('deletes a subreddit', async () => {
    await db.sql`INSERT INTO subreddits (name) VALUES ('homelab')`;

    expect((await request('/api/subreddits/homelab', {method: 'DELETE'})).status).toBe(200);
    expect((await request('/api/subreddits/homelab', {method: 'DELETE'})).status).toBe(404);
  });

  it('lists watched subreddits with their polling health', async () => {
    await db.sql`
      INSERT INTO subreddits (name, last_status, consecutive_errors)
      VALUES ('homelab', 'http_429', 2)`;

    const body = await (await request('/api/subreddits')).json() as {
      subreddits: Array<{name: string; last_status: string; consecutive_errors: number}>;
    };

    expect(body.subreddits[0]).toMatchObject({
      name: 'homelab', last_status: 'http_429', consecutive_errors: 2,
    });
  });
});

describe('settings', () => {
  it('updates the evaluation prompt the workers use', async () => {
    const res = await request('/api/settings/eval_prompt', {
      method: 'PUT',
      body: JSON.stringify({value: 'Only DDR5 ECC RAM counts.'}),
    });

    expect(res.status).toBe(200);
    const [row] = await db.sql<Array<{value: string}>>`
      SELECT value FROM settings WHERE key = 'eval_prompt'`;
    expect(row?.value).toBe('Only DDR5 ECC RAM counts.');
  });

  it('sets the telegram recipients', async () => {
    const res = await request('/api/settings/telegram_chat_ids', {
      method: 'PUT',
      body: JSON.stringify({value: ['123456', '789012']}),
    });

    expect(res.status).toBe(200);
    const [row] = await db.sql<Array<{value: string[]}>>`
      SELECT value FROM settings WHERE key = 'telegram_chat_ids'`;
    expect(row?.value).toEqual(['123456', '789012']);
  });

  it('rejects an unknown setting key', async () => {
    const res = await request('/api/settings/nonsense', {
      method: 'PUT',
      body: JSON.stringify({value: 'x'}),
    });

    expect(res.status).toBe(400);
  });

  it('rejects an empty prompt', async () => {
    const res = await request('/api/settings/eval_prompt', {
      method: 'PUT',
      body: JSON.stringify({value: '   '}),
    });

    expect(res.status).toBe(400);
  });

  it('rejects a model id that is not an OpenRouter path', async () => {
    const res = await request('/api/settings/llm_model', {
      method: 'PUT',
      body: JSON.stringify({value: 'gpt-4o-mini'}),
    });

    expect(res.status).toBe(400);
  });

  it('accepts a valid OpenRouter model id', async () => {
    const res = await request('/api/settings/llm_model', {
      method: 'PUT',
      body: JSON.stringify({value: 'anthropic/claude-haiku-4.5'}),
    });

    expect(res.status).toBe(200);
  });

  it('refuses a model whose provider has no key, and takes it once one lands', async () => {
    const put = () => request('/api/settings/llm_model', {
      method: 'PUT',
      body: JSON.stringify({value: 'anthropic:claude-sonnet-5-5'}),
    });

    const refused = await put();
    expect(refused.status).toBe(409);
    expect((await refused.json() as {error: string}).error).toContain('no anthropic API key');
    expect((await new SettingsStore(db.sql, 0).get()).llmModel).not.toBe('anthropic:claude-sonnet-5-5');

    await request('/api/llm-keys/anthropic', {method: 'PUT', body: JSON.stringify({key: 'sk-ant-1234'})});
    expect((await put()).status).toBe(200);
  });

  it('refuses a candidate model whose provider has no key, but not ""', async () => {
    const put = (value: string) => request('/api/settings/candidate_llm_model', {
      method: 'PUT',
      body: JSON.stringify({value}),
    });

    expect((await put('openai:gpt-6-luna')).status).toBe(409);
    expect((await put('')).status).toBe(200);
  });

  it('switches poll_source between reddit and webhook only', async () => {
    const put = (value: unknown) => request('/api/settings/poll_source', {
      method: 'PUT',
      body: JSON.stringify({value}),
    });

    expect((await put('webhook')).status).toBe(200);
    expect((await put('rss')).status).toBe(400);
    expect((await put('reddit')).status).toBe(200);
  });

  it('sets the dev chats and rejects anything but a list of chat ids', async () => {
    const ok = await request('/api/settings/telegram_dev_chat_ids', {
      method: 'PUT',
      body: JSON.stringify({value: ['-1009000000001']}),
    });
    const bad = await request('/api/settings/telegram_dev_chat_ids', {
      method: 'PUT',
      body: JSON.stringify({value: '-1009000000001'}),
    });

    expect(ok.status).toBe(200);
    expect(bad.status).toBe(400);
    expect((await bad.json() as {error: string}).error).toContain('telegram_dev_chat_ids');
  });

  it('accepts an empty candidate prompt, which ends the trial', async () => {
    for (const value of ['Judge bulk lots only.', '']) {
      const res = await request('/api/settings/candidate_eval_prompt', {
        method: 'PUT',
        body: JSON.stringify({value}),
      });
      expect(res.status).toBe(200);
    }
    const bad = await request('/api/settings/candidate_eval_prompt', {
      method: 'PUT',
      body: JSON.stringify({value: 7}),
    });
    expect(bad.status).toBe(400);
  });

  it('takes "" or an OpenRouter id as the candidate model', async () => {
    const statuses = [];
    for (const value of ['', 'anthropic/claude-haiku-5.5', 'claude-haiku']) {
      statuses.push((await request('/api/settings/candidate_llm_model', {
        method: 'PUT',
        body: JSON.stringify({value}),
      })).status);
    }
    expect(statuses).toEqual([200, 200, 400]);
  });

  it('rejects an out-of-range post age', async () => {
    const res = await request('/api/settings/max_post_age_hours', {
      method: 'PUT',
      body: JSON.stringify({value: 0}),
    });

    expect(res.status).toBe(400);
  });

  it('returns every setting', async () => {
    const body = await (await request('/api/settings')).json() as {
      settings: Record<string, unknown>;
    };

    expect(Object.keys(body.settings).sort()).toEqual([
      'candidate_eval_prompt', 'candidate_llm_model', 'eval_prompt', 'llm_model',
      'max_post_age_hours', 'poll_source', 'telegram_chat_ids', 'telegram_dev_chat_ids',
    ]);
  });
});

describe('stats and requeue', () => {
  it('summarises the pipeline by status', async () => {
    await seedTarget('t3_a', 'item');
    await db.sql`
      INSERT INTO posts (reddit_id, subreddit, title, url, posted_at, status, attempts)
      VALUES ('t3_f', 'homelab', 'broken', 'https://x', NOW(), 'failed', 5)`;

    const body = await (await request('/api/stats')).json() as {
      posts: Record<string, number>;
      failed: Array<{reddit_id: string}>;
    };

    expect(body.posts['notified']).toBe(1);
    expect(body.posts['failed']).toBe(1);
    expect(body.failed[0]?.reddit_id).toBe('t3_f');
  });

  it('counts only posts discovered since the given time', async () => {
    await seedTarget('t3_old', 'old item');
    await db.sql`UPDATE posts SET discovered_at = NOW() - INTERVAL '2 days'`;
    await seedTarget('t3_new', 'new item');

    const allTime = await (await request('/api/stats')).json() as {posts: Record<string, number>};
    expect(allTime.posts['notified']).toBe(2);

    const since = new Date(Date.now() - 86_400_000).toISOString();
    const windowed = await (await request(`/api/stats?since=${since}`)).json() as {
      posts: Record<string, number>;
    };
    expect(windowed.posts['notified']).toBe(1);
  });

  it('rejects an unparseable since value on stats', async () => {
    expect((await request('/api/stats?since=yesterday')).status).toBe(400);
  });

  it('puts a failed post back in the queue', async () => {
    await db.sql`
      INSERT INTO posts (reddit_id, subreddit, title, url, posted_at, status, attempts)
      VALUES ('t3_f', 'homelab', 'broken', 'https://x', NOW(), 'failed', 5)`;

    expect((await request('/api/posts/t3_f/requeue', {method: 'POST'})).status).toBe(200);

    const [row] = await db.sql<Array<{status: string; attempts: number}>>`
      SELECT status, attempts FROM posts WHERE reddit_id = 't3_f'`;
    expect(row).toMatchObject({status: 'new', attempts: 0});
  });

  it('404s when requeueing a post we never saw', async () => {
    expect((await request('/api/posts/t3_missing/requeue', {method: 'POST'})).status).toBe(404);
  });
});

describe('POST /api/telegram/test', () => {
  it('refuses to send when no recipients are configured', async () => {
    const res = await request('/api/telegram/test', {method: 'POST', body: '{}'});

    expect(res.status).toBe(400);
  });

  it('sends to the configured chats', async () => {
    await db.sql`
      UPDATE settings SET value = '["111"]'::jsonb WHERE key = 'telegram_chat_ids'`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ok: true}), {status: 200}),
    ));

    const res = await request('/api/telegram/test', {
      method: 'POST',
      body: JSON.stringify({message: 'ping'}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({delivered: ['111']});
  });

  it('reports a bad gateway when no chat could be reached', async () => {
    await db.sql`
      UPDATE settings SET value = '["111"]'::jsonb WHERE key = 'telegram_chat_ids'`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ok: false, description: 'chat not found'}), {status: 400}),
    ));

    const res = await request('/api/telegram/test', {method: 'POST', body: '{}'});

    expect(res.status).toBe(502);
  });
});

describe('workers endpoints', () => {
  async function seedWorker(id: string, role: string, heartbeatAgoSeconds: number): Promise<void> {
    await db.sql`
      INSERT INTO workers (worker_id, role, started_at, last_heartbeat_at, loops)
      VALUES (${id}, ${role}, NOW() - INTERVAL '1 day',
              NOW() - ${heartbeatAgoSeconds} * INTERVAL '1 second',
              '{"poll": {"lastSuccessAt": "2026-08-14T12:00:00.000Z", "lastWorkAt": null}}'::jsonb)`;
  }

  it('requires auth', async () => {
    const res = await app.request('/api/workers');

    expect(res.status).toBe(401);
  });

  it('lists workers with camelCase fields and seconds since the last heartbeat', async () => {
    await seedWorker('w-live', 'worker', 5);
    await seedWorker('w-api', 'api', 120);

    const body = await (await request('/api/workers')).json() as {
      workers: Array<{
        workerId: string; role: string; startedAt: string; lastHeartbeatAt: string;
        secondsSinceHeartbeat: number;
        loops: Record<string, {lastSuccessAt: string | null; lastWorkAt: string | null}>;
      }>;
    };

    expect(body.workers.map((w) => w.workerId).sort()).toEqual(['w-api', 'w-live']);
    const live = body.workers.find((w) => w.workerId === 'w-live')!;
    expect(live.role).toBe('worker');
    expect(live.secondsSinceHeartbeat).toBeGreaterThanOrEqual(4);
    expect(live.secondsSinceHeartbeat).toBeLessThan(30);
    expect(live.loops['poll']!.lastSuccessAt).toBe('2026-08-14T12:00:00.000Z');
  });

  it('filters workers by liveness status', async () => {
    await seedWorker('w-live', 'worker', 5);
    await seedWorker('w-stale', 'worker', 200);
    await seedWorker('w-dead', 'worker', 4000);

    const live = await (await request('/api/workers?status=live')).json() as
      {workers: Array<{workerId: string}>; total: number};
    const stale = await (await request('/api/workers?status=stale')).json() as
      {workers: Array<{workerId: string}>; total: number};
    const dead = await (await request('/api/workers?status=dead')).json() as
      {workers: Array<{workerId: string}>; total: number};
    const all = await (await request('/api/workers?status=all')).json() as
      {workers: Array<{workerId: string}>; total: number};

    expect(live.workers.map((w) => w.workerId)).toEqual(['w-live']);
    expect(live.total).toBe(1);
    expect(stale.workers.map((w) => w.workerId)).toEqual(['w-stale']);
    expect(dead.workers.map((w) => w.workerId)).toEqual(['w-dead']);
    expect(all.total).toBe(3);
  });

  it('orders by most recent heartbeat and paginates with limit/offset', async () => {
    await seedWorker('w-a', 'worker', 30);
    await seedWorker('w-b', 'worker', 10);
    await seedWorker('w-c', 'worker', 20);

    const first = await (await request('/api/workers?limit=2&offset=0')).json() as
      {workers: Array<{workerId: string}>; total: number};
    const second = await (await request('/api/workers?limit=2&offset=2')).json() as
      {workers: Array<{workerId: string}>; total: number};

    expect(first.workers.map((w) => w.workerId)).toEqual(['w-b', 'w-c']);
    expect(first.total).toBe(3);
    expect(second.workers.map((w) => w.workerId)).toEqual(['w-a']);
    expect(second.total).toBe(3);
  });

  it('rejects an unknown status value', async () => {
    expect((await request('/api/workers?status=zombie')).status).toBe(400);
  });

  it('deletes a decommissioned worker row', async () => {
    await seedWorker('w-old', 'worker', 9999);

    const res = await request('/api/workers/w-old', {method: 'DELETE'});

    expect(res.status).toBe(200);
    expect(await (await request('/api/workers')).json()).toMatchObject({workers: []});
  });

  it('404s when deleting an unknown worker', async () => {
    const res = await request('/api/workers/nope', {method: 'DELETE'});

    expect(res.status).toBe(404);
  });
});

describe('rules endpoints', () => {
  it('requires auth', async () => {
    const res = await app.request('/api/rules');

    expect(res.status).toBe(401);
  });

  it('creates a rule and returns it camelCased', async () => {
    const res = await request('/api/rules', {
      method: 'POST',
      body: JSON.stringify({name: 'EPYC lots', prompt: 'Alert on bulk EPYC CPU lots.'}),
    });

    expect(res.status).toBe(201);
    const body = await res.json() as {rule: {id: number; name: string; enabled: boolean; createdAt: string}};
    expect(body.rule).toMatchObject({name: 'EPYC lots', enabled: true});
    expect(body.rule.id).toBeGreaterThan(0);
    expect(typeof body.rule.createdAt).toBe('string');
  });

  it('rejects a rule with a blank name or prompt', async () => {
    const noName = await request('/api/rules', {
      method: 'POST',
      body: JSON.stringify({name: '  ', prompt: 'p'}),
    });
    const noPrompt = await request('/api/rules', {
      method: 'POST',
      body: JSON.stringify({name: 'n', prompt: ''}),
    });

    expect(noName.status).toBe(400);
    expect(noPrompt.status).toBe(400);
  });

  it('lists rules in creation order', async () => {
    await request('/api/rules', {method: 'POST', body: JSON.stringify({name: 'A', prompt: 'a'})});
    await request('/api/rules', {method: 'POST', body: JSON.stringify({name: 'B', prompt: 'b'})});

    const body = await (await request('/api/rules')).json() as {rules: Array<{name: string}>};

    expect(body.rules.map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('patches enabled and prompt independently', async () => {
    const created = await (await request('/api/rules', {
      method: 'POST',
      body: JSON.stringify({name: 'A', prompt: 'a'}),
    })).json() as {rule: {id: number}};

    const res = await request(`/api/rules/${created.rule.id}`, {
      method: 'PATCH',
      body: JSON.stringify({enabled: false}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({rule: {name: 'A', prompt: 'a', enabled: false}});
  });

  it('404s when patching or deleting an unknown rule', async () => {
    const patch = await request('/api/rules/999999', {
      method: 'PATCH',
      body: JSON.stringify({enabled: false}),
    });
    const del = await request('/api/rules/999999', {method: 'DELETE'});

    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
  });

  it('deletes a rule', async () => {
    const created = await (await request('/api/rules', {
      method: 'POST',
      body: JSON.stringify({name: 'A', prompt: 'a'}),
    })).json() as {rule: {id: number}};

    const res = await request(`/api/rules/${created.rule.id}`, {method: 'DELETE'});

    expect(res.status).toBe(200);
    expect(await (await request('/api/rules')).json()).toMatchObject({rules: []});
  });
});

describe('prompt scoring', () => {
  const BUYERS = '-1003943525487';
  const DEV = '-1009000000001';

  async function setSetting(key: string, value: unknown): Promise<void> {
    await db.sql`UPDATE settings SET value = ${db.sql.json(value as never)} WHERE key = ${key}`;
  }

  beforeEach(async () => {
    await db.sql`DELETE FROM prompt_versions`;
    await db.sql`DELETE FROM message_reactions`;
    await db.sql`DELETE FROM message_reaction_counts`;
    await setSetting('eval_prompt', 'Live prompt: ECC RAM and SSDs.');
    await setSetting('llm_model', 'openai/gpt-4o-mini');
    await setSetting('candidate_eval_prompt', 'Candidate prompt: 7 or more units.');
    await setSetting('candidate_llm_model', '');
  });

  afterAll(async () => {
    await setSetting('candidate_eval_prompt', '');
  });

  async function versions(): Promise<{live: number; candidate: number; retired: number}> {
    const store = new SettingsStore(db.sql, 0);
    const current = await store.get();
    return {
      live: await ensurePromptVersion(db.sql, liveConfig(current, [])),
      candidate: await ensurePromptVersion(db.sql, candidateConfig(current)!),
      retired: await ensurePromptVersion(db.sql, {model: 'old/model', systemPrompt: 'Old.'}),
    };
  }

  async function seedPost(
    id: string,
    versionId: number,
    isTarget: boolean,
    discoveredDaysAgo = 0,
  ): Promise<void> {
    await db.sql`
      INSERT INTO posts (reddit_id, subreddit, title, url, posted_at, discovered_at, status,
                         is_target, prompt_version_id)
      VALUES (${id}, 'homelabsales', 'A listing', ${`https://reddit.com/${id}`}, NOW(),
              NOW() - make_interval(days => ${discoveredDaysAgo}),
              ${isTarget ? 'notified' : 'rejected'}, ${isTarget}, ${versionId})`;
  }

  async function seedCandidate(id: string, versionId: number, isTarget: boolean): Promise<void> {
    await db.sql`
      INSERT INTO candidate_verdicts (reddit_id, prompt_version_id, is_target, summary, reasoning)
      VALUES (${id}, ${versionId}, ${isTarget}, 's', 'r')`;
  }

  async function sent(id: string, chatId: string, messageId: number, audience: string) {
    await db.sql`
      INSERT INTO alert_messages (chat_id, message_id, reddit_id, audience)
      VALUES (${chatId}, ${messageId}, ${id}, ${audience})`;
  }

  async function react(chatId: string, messageId: number, emoji: string[], reactor = '7001') {
    await db.sql`
      INSERT INTO message_reactions (chat_id, message_id, reactor, emoji, updated_at)
      VALUES (${chatId}, ${messageId}, ${reactor}, ${db.sql.json(emoji)}, NOW())`;
  }

  /**
   * p1: both flag it, buyers 👍            → a lead both would send
   * p2: live only, buyers 👎               → junk the candidate drops
   * p3: live only, dev channel count 👍    → a lead the candidate would lose
   * p4: candidate only, dev 👍             → a lead only the candidate finds
   * p5: neither                            → never sent, unlabelled
   * p6: a retired version, ten days ago, buyers 👍
   */
  async function seedScenario() {
    const v = await versions();
    await seedPost('p1', v.live, true);
    await seedCandidate('p1', v.candidate, true);
    await sent('p1', BUYERS, 1, 'buyers');
    await react(BUYERS, 1, ['👍']);

    await seedPost('p2', v.live, true);
    await seedCandidate('p2', v.candidate, false);
    await sent('p2', BUYERS, 2, 'buyers');
    await react(BUYERS, 2, ['👎']);

    await seedPost('p3', v.live, true);
    await seedCandidate('p3', v.candidate, false);
    await sent('p3', BUYERS, 3, 'buyers');
    await sent('p3', DEV, 10, 'dev');
    await db.sql`
      INSERT INTO message_reaction_counts (chat_id, message_id, counts, updated_at)
      VALUES (${DEV}, 10, ${db.sql.json({'👍': 1})}, NOW())`;

    await seedPost('p4', v.live, false);
    await seedCandidate('p4', v.candidate, true);
    await sent('p4', DEV, 11, 'dev');
    await react(DEV, 11, ['🔥']);

    await seedPost('p5', v.live, false);
    await seedCandidate('p5', v.candidate, false);

    await seedPost('p6', v.retired, true, 10);
    await sent('p6', BUYERS, 4, 'buyers');
    await react(BUYERS, 4, ['👍']);

    // A reaction on a message the ledger never saw, e.g. an alert from before it.
    await react(BUYERS, 999, ['👍']);
    return v;
  }

  type Stats = {
    unmatchedReactions: number;
    versions: Array<{
      id: number;
      role: string;
      responseSchema: string;
      evaluated: number;
      targets: number;
      buyers: {sent: number; leads: number; notLeads: number; leadRate: number | null};
      dev: {sent: number; leads: number; notLeads: number};
      vsLive?: Record<string, {posts: number; leads: number; notLeads: number}>;
    }>;
  };

  it('scores the live prompt by the leads its alerts drew', async () => {
    const v = await seedScenario();

    const body = await (await request('/api/prompt-stats')).json() as Stats;

    const live = body.versions.find((x) => x.id === v.live)!;
    expect(live).toMatchObject({
      role: 'live',
      responseSchema: 'reasoning-first',
      evaluated: 5,
      targets: 3,
      buyers: {sent: 3, leads: 1, notLeads: 1, leadRate: 1 / 3},
      dev: {sent: 1, leads: 1, notLeads: 0},
    });
    expect(live.vsLive).toBeUndefined();
    expect(body.unmatchedReactions).toBe(1);
  });

  it('sets the candidate against the live verdicts on the same posts', async () => {
    const v = await seedScenario();

    const body = await (await request('/api/prompt-stats')).json() as Stats;

    const candidate = body.versions.find((x) => x.id === v.candidate)!;
    expect(candidate).toMatchObject({
      role: 'candidate',
      evaluated: 5,
      targets: 2,
      buyers: {sent: 1, leads: 1},
      dev: {sent: 1, leads: 1},
    });
    expect(candidate.vsLive).toEqual({
      both: {posts: 1, leads: 1, notLeads: 0},
      liveOnly: {posts: 2, leads: 1, notLeads: 1},
      candidateOnly: {posts: 1, leads: 1, notLeads: 0},
      neither: {posts: 1, leads: 0, notLeads: 0},
    });
  });

  it('counts only posts discovered since the given time', async () => {
    const v = await seedScenario();

    const all = await (await request('/api/prompt-stats')).json() as Stats;
    const since = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const recent = await (await request(`/api/prompt-stats?since=${since}`)).json() as Stats;

    expect(all.versions.find((x) => x.id === v.retired)).toMatchObject({
      role: 'retired', evaluated: 1, buyers: {sent: 1, leads: 1},
    });
    expect(recent.versions.find((x) => x.id === v.retired)).toMatchObject({
      evaluated: 0, buyers: {sent: 0, leads: 0, leadRate: null},
    });
    expect((await request('/api/prompt-stats?since=yesterday')).status).toBe(400);
  });

  it('promotes the candidate to live, disabling the rules, under the same version id', async () => {
    const v = await versions();
    await setSetting('candidate_llm_model', 'anthropic/claude-haiku-5.5');
    const candidateId = await ensurePromptVersion(
      db.sql, candidateConfig(await new SettingsStore(db.sql, 0).get())!,
    );
    const [rule] = await db.sql<Array<{id: number}>>`
      INSERT INTO rules (name, prompt) VALUES ('Old rule', 'Old wording.') RETURNING id`;

    const res = await request('/api/prompt-candidate/promote', {method: 'POST'});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      evalPrompt: 'Candidate prompt: 7 or more units.',
      llmModel: 'anthropic/claude-haiku-5.5',
      disabledRules: [rule!.id],
      promptVersionId: candidateId,
    });
    const now = await new SettingsStore(db.sql, 0).get();
    expect(now).toMatchObject({
      evalPrompt: 'Candidate prompt: 7 or more units.',
      llmModel: 'anthropic/claude-haiku-5.5',
      candidateEvalPrompt: '',
      candidateLlmModel: '',
    });
    const [after] = await db.sql<Array<{enabled: boolean}>>`
      SELECT enabled FROM rules WHERE id = ${rule!.id}`;
    expect(after?.enabled).toBe(false);

    const stats = await (await request('/api/prompt-stats')).json() as Stats;
    expect(stats.versions.find((x) => x.id === candidateId)?.role).toBe('live');
    expect(stats.versions.find((x) => x.id === v.live)?.role).toBe('retired');
  });

  it('reports the configured prompts, so a trial shows before its first verdict', async () => {
    await db.sql`INSERT INTO rules (name, prompt) VALUES ('Rule', 'Some wording.')`;

    const before = await (await request('/api/prompt-stats')).json() as {
      config: {
        live: {model: string; systemPrompt: string; promptVersionId: number | null};
        candidate: {model: string; systemPrompt: string; promptVersionId: number | null} | null;
        enabledRules: number;
      };
    };
    expect(before.config).toEqual({
      live: {
        model: 'openai/gpt-4o-mini',
        systemPrompt: expect.stringContaining('Rule: Some wording.'),
        promptVersionId: null,
      },
      candidate: {
        model: 'openai/gpt-4o-mini',
        systemPrompt: 'Candidate prompt: 7 or more units.',
        promptVersionId: null,
      },
      enabledRules: 1,
    });

    await db.sql`DELETE FROM rules`;
    const v = await seedScenario();
    const after = await (await request('/api/prompt-stats')).json() as typeof before;
    expect(after.config.live.promptVersionId).toBe(v.live);
    expect(after.config.candidate?.promptVersionId).toBe(v.candidate);
  });

  it('starts a trial through its own route, validating the prompt and model', async () => {
    await setSetting('candidate_eval_prompt', '');
    const put = (body: unknown) => request('/api/prompt-candidate', {
      method: 'PUT', body: JSON.stringify(body),
    });

    expect((await put({prompt: '   '})).status).toBe(400);
    expect((await put({prompt: 'P', model: 'gpt-4o-mini'})).status).toBe(400);
    const noKey = await put({prompt: 'P', model: 'anthropic:claude-haiku-5-5'});
    expect(noKey.status).toBe(409);
    expect((await noKey.json() as {error: string}).error)
      .toBe("the tracker has no anthropic API key for anthropic:claude-haiku-5-5: paste one on the ERP's Settings ▸ AI models first");
    expect((await new SettingsStore(db.sql, 0).get()).candidateEvalPrompt).toBe('');

    const res = await put({prompt: '  Judge bulk lots only.  ', model: 'anthropic/claude-haiku-5.5'});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({candidate: {
      model: 'anthropic/claude-haiku-5.5',
      systemPrompt: 'Judge bulk lots only.',
      promptVersionId: null,
    }});
    expect(await new SettingsStore(db.sql, 0).get()).toMatchObject({
      candidateEvalPrompt: 'Judge bulk lots only.',
      candidateLlmModel: 'anthropic/claude-haiku-5.5',
    });

    // No model means the candidate runs on llm_model again.
    await put({prompt: 'Judge bulk lots only.'});
    expect((await new SettingsStore(db.sql, 0).get()).candidateLlmModel).toBe('');
  });

  it('ends a trial and keeps its numbers under a retired version', async () => {
    const v = await seedScenario();

    const res = await request('/api/prompt-candidate', {method: 'DELETE'});

    expect(res.status).toBe(200);
    const body = await (await request('/api/prompt-stats')).json() as Stats & {
      config: {candidate: unknown};
    };
    expect(body.config.candidate).toBeNull();
    expect(body.versions.find((x) => x.id === v.candidate)).toMatchObject({
      role: 'retired', evaluated: 5, targets: 2,
    });
  });

  it('refuses to promote a candidate whose provider key was removed', async () => {
    await setSetting('candidate_llm_model', 'openai:gpt-6-luna');

    const res = await request('/api/prompt-candidate/promote', {method: 'POST'});

    expect(res.status).toBe(409);
    expect((await new SettingsStore(db.sql, 0).get()).candidateLlmModel).toBe('openai:gpt-6-luna');
  });

  it('refuses to promote when no candidate is on trial', async () => {
    await setSetting('candidate_eval_prompt', '');

    const res = await request('/api/prompt-candidate/promote', {method: 'POST'});

    expect(res.status).toBe(400);
  });
});

describe('GET /api/analytics', () => {
  it('reports the requested window, 7 days by default', async () => {
    await seedTarget('t3_a', 'Lot of RAM');

    const res = await request('/api/analytics');
    expect(res.status).toBe(200);
    const body = await res.json() as {window: string; volume: {alerts: number}; hotPms: number};
    expect(body.window).toBe('7d');
    expect(body.volume.alerts).toBe(1);
    expect(body.hotPms).toBe(5);

    expect((await (await request('/api/analytics?window=30d')).json() as {window: string}).window).toBe('30d');
  });

  it('rejects a window it does not offer', async () => {
    const res = await request('/api/analytics?window=1y');
    expect(res.status).toBe(400);
  });

  it('requires the API token', async () => {
    expect((await app.request('/api/analytics')).status).toBe(401);
  });
});

describe('llm keys', () => {
  const SECRET = 'sk-or-v1-0123456789abcdefSECRET-ab12';

  beforeEach(async () => {
    await db.sql`DELETE FROM llm_keys`;
    keys.invalidate();
  });

  async function putKey(provider: string, body: unknown): Promise<Response> {
    return request(`/api/llm-keys/${provider}`, {method: 'PUT', body: JSON.stringify(body)});
  }

  it('stores a key, reports only its last 4 and deletes it', async () => {
    const put = await putKey('openrouter', {key: `  ${SECRET}  `});
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ok: true, last4: 'ab12'});

    const listed = await request('/api/llm-keys');
    const text = await listed.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({keys: [
      {provider: 'openrouter', configured: true, last4: 'ab12', available: true, source: 'stored'},
      {provider: 'anthropic', configured: false, last4: null, available: false, source: null},
      {provider: 'openai', configured: false, last4: null, available: false, source: null},
    ]});
    expect(await (await request('/api/settings')).text()).not.toContain(SECRET);

    const del = await request('/api/llm-keys/openrouter', {method: 'DELETE'});
    expect(await del.json()).toEqual({ok: true});
    const after = await (await request('/api/llm-keys')).json() as {
      keys: Array<{configured: boolean}>;
    };
    expect(after.keys.every((k) => !k.configured)).toBe(true);
  });

  it('reports a key imported from env like any stored key, and never shows it', async () => {
    await importEnvKeys(db.sql, {openrouter: 'env-or-key-wxyz'}, createLogger('t', 'error'));
    const res = await request('/api/llm-keys');
    const text = await res.text();

    expect(text).not.toContain('env-or-key');
    expect(JSON.parse(text).keys[0]).toEqual(
      {provider: 'openrouter', configured: true, last4: 'wxyz', available: true, source: 'stored'},
    );
  });

  it('rejects a key with inner whitespace, a line break or a control character', async () => {
    for (const key of ['sk-ant one', 'sk-ant\r\nX-Evil: 1', 'sk-ant\tx', 'sk-ant\u0000x', 'sk\u007fx']) {
      const res = await putKey('anthropic', {key});
      expect(res.status).toBe(400);
      expect(await res.text()).not.toContain('sk-ant');
    }
    expect((await keys.get()).anthropic).toBeUndefined();
    // Surrounding whitespace is trimmed, not refused.
    expect((await putKey('anthropic', {key: ' sk-ant-ok\n'})).status).toBe(200);
  });

  it('replaces a key and makes the new one visible at once', async () => {
    await putKey('anthropic', {key: 'sk-ant-old1'});
    expect((await keys.get()).anthropic).toBe('sk-ant-old1');

    await putKey('anthropic', {key: 'sk-ant-new2'});

    expect((await keys.get()).anthropic).toBe('sk-ant-new2');
    await request('/api/llm-keys/anthropic', {method: 'DELETE'});
    expect((await keys.get()).anthropic).toBeUndefined();
  });

  it('answers ok when deleting a key that was never set', async () => {
    const res = await request('/api/llm-keys/openai', {method: 'DELETE'});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true});
  });

  it('rejects an unknown provider', async () => {
    expect((await putKey('gemini', {key: 'x-key'})).status).toBe(400);
    expect((await request('/api/llm-keys/gemini', {method: 'DELETE'})).status).toBe(400);
  });

  it('rejects an empty, non-string or oversized key', async () => {
    expect((await putKey('openai', {key: '   '})).status).toBe(400);
    expect((await putKey('openai', {key: 42})).status).toBe(400);
    expect((await putKey('openai', {})).status).toBe(400);
    expect((await putKey('openai', {key: 'k'.repeat(501)})).status).toBe(400);
    expect((await putKey('openai', {key: 'k'.repeat(500)})).status).toBe(200);
  });

  it('requires the API token', async () => {
    expect((await app.request('/api/llm-keys')).status).toBe(401);
    expect((await app.request('/api/llm-keys/openai', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({key: 'sk-x'}),
    })).status).toBe(401);
    expect((await app.request('/api/llm-keys/openai', {method: 'DELETE'})).status).toBe(401);
  });
});

describe('KeyStore', () => {
  beforeEach(async () => {
    await db.sql`DELETE FROM llm_keys`;
  });

  it('serves only stored keys', async () => {
    await db.sql`INSERT INTO llm_keys (provider, api_key) VALUES ('openrouter', 'db-or')`;
    expect(await new KeyStore(db.sql, 0).get()).toEqual({openrouter: 'db-or'});
  });

  it('serves the cached keys until invalidated', async () => {
    let now = 0;
    const store = new KeyStore(db.sql, 60_000, () => now);
    expect(await store.get()).toEqual({});

    await db.sql`INSERT INTO llm_keys (provider, api_key) VALUES ('openai', 'db-oa')`;
    expect(await store.get()).toEqual({});

    store.invalidate();
    expect(await store.get()).toEqual({openai: 'db-oa'});

    await db.sql`DELETE FROM llm_keys`;
    now = 60_000;
    expect(await store.get()).toEqual({});
  });
});

describe('importEnvKeys', () => {
  const quiet = () => createLogger('t', 'error');
  const stored = async () => (await db.sql<Array<{provider: string; api_key: string}>>`
    SELECT provider, api_key FROM llm_keys ORDER BY provider`).map((r) => [r.provider, r.api_key]);

  beforeEach(async () => {
    await db.sql`DELETE FROM llm_keys`;
    await db.sql`DELETE FROM llm_keys_env_imported`;
  });

  it('copies each env key in once, trimmed, and the store serves it', async () => {
    expect(await importEnvKeys(db.sql, {openrouter: ' env-or ', anthropic: '', openai: 'env-oa'}, quiet()))
      .toEqual(['openrouter', 'openai']);
    expect(await stored()).toEqual([['openai', 'env-oa'], ['openrouter', 'env-or']]);
    expect(await new KeyStore(db.sql, 0).get()).toEqual({openrouter: 'env-or', openai: 'env-oa'});
  });

  it('leaves a key the ERP already pushed, and still marks the provider', async () => {
    await db.sql`INSERT INTO llm_keys (provider, api_key) VALUES ('openrouter', 'erp-or')`;
    expect(await importEnvKeys(db.sql, {openrouter: 'env-or'}, quiet())).toEqual([]);
    expect(await stored()).toEqual([['openrouter', 'erp-or']]);
    expect(await db.sql`SELECT provider FROM llm_keys_env_imported`).toEqual([{provider: 'openrouter'}]);
  });

  it('never brings back a key the ERP removed', async () => {
    await importEnvKeys(db.sql, {openrouter: 'env-or'}, quiet());
    const del = await request('/api/llm-keys/openrouter', {method: 'DELETE'});
    expect(del.status).toBe(200);

    expect(await importEnvKeys(db.sql, {openrouter: 'env-or'}, quiet())).toEqual([]);
    expect(await stored()).toEqual([]);
    const listed = await (await request('/api/llm-keys')).json() as {keys: Array<{available: boolean}>};
    expect(listed.keys[0]).toMatchObject({available: false, source: null});
  });

  it('still imports a provider a process without its key skipped', async () => {
    // The api booted with no key, a worker with one: the worker's lands.
    expect(await importEnvKeys(db.sql, {}, quiet())).toEqual([]);
    expect(await importEnvKeys(db.sql, {anthropic: 'env-ant'}, quiet())).toEqual(['anthropic']);
  });

  it('skips a malformed key without saying what it was', async () => {
    const logger = quiet();
    const error = vi.spyOn(logger, 'error');
    expect(await importEnvKeys(db.sql, {openai: 'sk bad key'}, logger)).toEqual([]);
    expect(JSON.stringify(error.mock.calls)).not.toContain('sk bad key');
    expect(await db.sql`SELECT 1 FROM llm_keys_env_imported`).toHaveLength(0);
  });

  it('never throws, so a database it cannot use does not stop the boot', async () => {
    const logger = quiet();
    const error = vi.spyOn(logger, 'error');
    const broken = {begin: async () => { throw new Error('connection refused'); }} as unknown as typeof db.sql;
    expect(await importEnvKeys(broken, {openrouter: 'env-or'}, logger)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
