import type {Hono} from 'hono';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApi} from '../src/api.ts';
import {SettingsStore} from '../src/settings.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

const TOKEN = 'test-token';
let db: TestDb;
let app: Hono;

beforeAll(async () => {
  db = await createTestDb('api');
  app = createApi({
    sql: db.sql,
    settings: new SettingsStore(db.sql, 0),
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
      'eval_prompt', 'llm_model', 'max_post_age_hours', 'telegram_chat_ids',
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
