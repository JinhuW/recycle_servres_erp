// Admin and UI surface. This is the only way to change what the fleet watches
// or how it evaluates posts — there is no CLI. All state lives in the shared
// database, so this can run anywhere that can reach it.

import {Hono} from 'hono';
import {requeuePost} from './claims.ts';
import type {Sql} from './db.ts';
import {isSettingKey, SETTING_KEYS, type SettingsStore} from './settings.ts';
import {sendMessage} from './telegram.ts';

export interface ApiDeps {
  sql: Sql;
  settings: SettingsStore;
  botToken: string;
  apiToken: string;
  workerId: string;
  startedAt: number;
}

export interface MatchRow {
  reddit_id: string;
  subreddit: string;
  title: string;
  llm_summary: string | null;
  llm_price: string | null;
  url: string;
  posted_at: Date;
  discovered_at: Date;
  notified_at: Date | null;
  status: string;
}

const MAX_LIMIT = 500;

function parseLimit(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();

  // Health is unauthenticated so uptime checks and load balancers can use it.
  app.get('/health', async (c) => {
    let dbOk = true;
    let counts: Record<string, number> = {};
    try {
      const rows = await deps.sql<Array<{status: string; count: string}>>`
        SELECT status, COUNT(*)::text AS count FROM posts GROUP BY status`;
      counts = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    } catch {
      dbOk = false;
    }
    return c.json({
      ok: dbOk,
      workerId: deps.workerId,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      posts: counts,
    }, dbOk ? 200 : 503);
  });

  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!deps.apiToken || token !== deps.apiToken) {
      return c.json({error: 'unauthorized'}, 401);
    }
    await next();
  });

  // The deliverable: LLM summary plus the link, newest first.
  app.get('/api/matches', async (c) => {
    const limit = parseLimit(c.req.query('limit'), 50);
    const since = c.req.query('since');
    const sinceDate = since ? new Date(since) : null;
    if (sinceDate && Number.isNaN(sinceDate.getTime())) {
      return c.json({error: 'since must be an ISO 8601 timestamp'}, 400);
    }

    const rows = await deps.sql<MatchRow[]>`
      SELECT reddit_id, subreddit, title, llm_summary, llm_price, url,
             posted_at, discovered_at, notified_at, status
        FROM posts
       WHERE is_target IS TRUE
         ${sinceDate ? deps.sql`AND discovered_at >= ${sinceDate}` : deps.sql``}
       ORDER BY discovered_at DESC
       LIMIT ${limit}`;

    return c.json({
      count: rows.length,
      matches: rows.map((r) => ({
        redditId: r.reddit_id,
        subreddit: r.subreddit,
        title: r.title,
        summary: r.llm_summary,
        price: r.llm_price,
        url: r.url,
        postedAt: r.posted_at,
        discoveredAt: r.discovered_at,
        notifiedAt: r.notified_at,
        status: r.status,
      })),
    });
  });

  app.get('/api/subreddits', async (c) => {
    const rows = await deps.sql`
      SELECT name, enabled, poll_interval_seconds, next_poll_at, last_polled_at,
             last_status, consecutive_errors, claimed_by
        FROM subreddits ORDER BY name`;
    return c.json({subreddits: rows});
  });

  app.post('/api/subreddits', async (c) => {
    const body = await c.req.json().catch(() => null) as
      {name?: unknown; pollIntervalSeconds?: unknown} | null;
    const name = typeof body?.name === 'string' ? body.name.trim().replace(/^\/?r\//, '') : '';
    if (!/^[A-Za-z0-9_]{2,30}$/.test(name)) {
      return c.json({error: 'name must be a subreddit name without the r/ prefix'}, 400);
    }

    const interval = body?.pollIntervalSeconds === undefined
      ? 90
      : Number(body.pollIntervalSeconds);
    if (!Number.isFinite(interval) || interval < 30) {
      return c.json({error: 'pollIntervalSeconds must be at least 30'}, 400);
    }

    const [row] = await deps.sql`
      INSERT INTO subreddits (name, poll_interval_seconds)
      VALUES (${name.toLowerCase()}, ${Math.floor(interval)})
      ON CONFLICT (name) DO UPDATE
        SET enabled = TRUE, poll_interval_seconds = EXCLUDED.poll_interval_seconds
      RETURNING *`;
    return c.json({subreddit: row}, 201);
  });

  app.patch('/api/subreddits/:name', async (c) => {
    const name = c.req.param('name').toLowerCase();
    const body = await c.req.json().catch(() => null) as
      {enabled?: unknown; pollIntervalSeconds?: unknown} | null;
    if (!body) return c.json({error: 'body must be a JSON object'}, 400);

    const enabled = typeof body.enabled === 'boolean' ? body.enabled : null;
    let interval: number | null = null;
    if (body.pollIntervalSeconds !== undefined) {
      const value = Number(body.pollIntervalSeconds);
      if (!Number.isFinite(value) || value < 30) {
        return c.json({error: 'pollIntervalSeconds must be at least 30'}, 400);
      }
      interval = Math.floor(value);
    }
    if (enabled === null && interval === null) {
      return c.json({error: 'nothing to update'}, 400);
    }

    const [row] = await deps.sql`
      UPDATE subreddits
         SET enabled = COALESCE(${enabled}, enabled),
             poll_interval_seconds = COALESCE(${interval}, poll_interval_seconds)
       WHERE name = ${name}
      RETURNING *`;
    if (!row) return c.json({error: 'not found'}, 404);
    return c.json({subreddit: row});
  });

  app.delete('/api/subreddits/:name', async (c) => {
    const rows = await deps.sql`
      DELETE FROM subreddits WHERE name = ${c.req.param('name').toLowerCase()}
      RETURNING name`;
    if (rows.length === 0) return c.json({error: 'not found'}, 404);
    return c.json({deleted: rows[0]!['name']});
  });

  app.get('/api/settings', async (c) => c.json({settings: await deps.settings.all()}));

  app.put('/api/settings/:key', async (c) => {
    const key = c.req.param('key');
    if (!isSettingKey(key)) {
      return c.json({error: `unknown setting; expected one of ${SETTING_KEYS.join(', ')}`}, 400);
    }

    const body = await c.req.json().catch(() => null) as {value?: unknown} | null;
    if (!body || !('value' in body)) {
      return c.json({error: 'body must be {"value": …}'}, 400);
    }

    const invalid = validateSetting(key, body.value);
    if (invalid) return c.json({error: invalid}, 400);

    await deps.settings.set(key, body.value);
    return c.json({key, value: body.value});
  });

  app.get('/api/stats', async (c) => {
    const [byStatus, subreddits, oldest] = await Promise.all([
      deps.sql<Array<{status: string; count: string}>>`
        SELECT status, COUNT(*)::text AS count FROM posts GROUP BY status`,
      deps.sql`
        SELECT name, enabled, last_status, consecutive_errors, last_polled_at, next_poll_at
          FROM subreddits ORDER BY name`,
      deps.sql<Array<{reddit_id: string; discovered_at: Date}>>`
        SELECT reddit_id, discovered_at FROM posts
         WHERE status = 'new' ORDER BY discovered_at LIMIT 1`,
    ]);

    const failed = await deps.sql<Array<{reddit_id: string; title: string; attempts: number}>>`
      SELECT reddit_id, title, attempts FROM posts
       WHERE status = 'failed' ORDER BY discovered_at DESC LIMIT 50`;

    return c.json({
      posts: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.count)])),
      oldestPending: oldest[0] ?? null,
      subreddits,
      failed,
    });
  });

  app.post('/api/posts/:id/requeue', async (c) => {
    const ok = await requeuePost(deps.sql, c.req.param('id'));
    if (!ok) return c.json({error: 'not found'}, 404);
    return c.json({requeued: c.req.param('id')});
  });

  app.post('/api/telegram/test', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {message?: unknown};
    const message = typeof body.message === 'string' && body.message.trim() !== ''
      ? body.message
      : 'Test alert from the Recycle Servers Reddit tracker.';

    const {telegramChatIds} = await deps.settings.get();
    if (telegramChatIds.length === 0) {
      return c.json({error: 'no telegram_chat_ids configured'}, 400);
    }

    const report = await sendMessage(deps.botToken, telegramChatIds, message);
    return c.json(report, report.delivered.length > 0 ? 200 : 502);
  });

  return app;
}

function validateSetting(key: string, value: unknown): string | null {
  switch (key) {
    case 'eval_prompt':
      return typeof value === 'string' && value.trim().length > 0
        ? null
        : 'eval_prompt must be a non-empty string';
    case 'llm_model':
      return typeof value === 'string' && /^[\w.-]+\/[\w.:-]+$/.test(value)
        ? null
        : 'llm_model must be an OpenRouter model id, e.g. "openai/gpt-4o-mini"';
    case 'telegram_chat_ids':
      return Array.isArray(value)
        && value.every((v) => typeof v === 'string' || typeof v === 'number')
        ? null
        : 'telegram_chat_ids must be an array of chat ids';
    case 'max_post_age_hours':
      return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 720
        ? null
        : 'max_post_age_hours must be a number between 1 and 720';
    default:
      return 'unknown setting';
  }
}
