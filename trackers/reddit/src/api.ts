// Admin and UI surface. This is the only way to change what the fleet watches
// or how it evaluates posts — there is no CLI. All state lives in the shared
// database, so this can run anywhere that can reach it.

import {Hono} from 'hono';
import {requeuePost} from './claims.ts';
import type {Sql} from './db.ts';
import {DEAD_AFTER_S, STALE_AFTER_S, type LoopName, type LoopStatus} from './heartbeat.ts';
import {createRule, deleteRule, listRules, updateRule} from './rules.ts';
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

function parseSince(raw: string | undefined): Date | null | 'invalid' {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? 'invalid' : date;
}

const SINCE_INVALID = 'since must be an ISO 8601 timestamp';

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
    const sinceDate = parseSince(c.req.query('since'));
    if (sinceDate === 'invalid') return c.json({error: SINCE_INVALID}, 400);

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

  // Fleet visibility, filterable by liveness and paginated for the UI's
  // infinite scroll. Most recently heard-from first.
  const WORKER_STATUSES = ['all', 'live', 'stale', 'dead'] as const;

  app.get('/api/workers', async (c) => {
    const status = c.req.query('status') ?? 'all';
    if (!(WORKER_STATUSES as readonly string[]).includes(status)) {
      return c.json({error: `status must be one of ${WORKER_STATUSES.join(', ')}`}, 400);
    }
    const limit = parseLimit(c.req.query('limit'), 100);
    const rawOffset = Number(c.req.query('offset') ?? 0);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

    const {sql} = deps;
    const age = sql`EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at))`;
    const statusFilter =
      status === 'live' ? sql`WHERE ${age} < ${STALE_AFTER_S}`
      : status === 'stale' ? sql`WHERE ${age} >= ${STALE_AFTER_S} AND ${age} < ${DEAD_AFTER_S}`
      : status === 'dead' ? sql`WHERE ${age} >= ${DEAD_AFTER_S}`
      : sql``;

    const [countRows, rows] = await Promise.all([
      sql<Array<{total: string}>>`SELECT COUNT(*)::text AS total FROM workers ${statusFilter}`,
      sql<Array<{
        worker_id: string;
        role: string;
        started_at: Date;
        last_heartbeat_at: Date;
        seconds_since_heartbeat: number;
        loops: Record<LoopName, LoopStatus>;
      }>>`
        SELECT worker_id, role, started_at, last_heartbeat_at,
               EXTRACT(EPOCH FROM (NOW() - last_heartbeat_at))::float8 AS seconds_since_heartbeat,
               loops
          FROM workers ${statusFilter}
         ORDER BY last_heartbeat_at DESC, worker_id
         LIMIT ${limit} OFFSET ${offset}`,
    ]);

    return c.json({
      total: Number(countRows[0]?.total ?? 0),
      workers: rows.map((r) => ({
        workerId: r.worker_id,
        role: r.role,
        startedAt: r.started_at,
        lastHeartbeatAt: r.last_heartbeat_at,
        secondsSinceHeartbeat: r.seconds_since_heartbeat,
        loops: r.loops,
      })),
    });
  });

  app.delete('/api/workers/:id', async (c) => {
    const rows = await deps.sql`
      DELETE FROM workers WHERE worker_id = ${c.req.param('id')} RETURNING worker_id`;
    if (rows.length === 0) return c.json({error: 'not found'}, 404);
    return c.json({deleted: c.req.param('id')});
  });

  const ruleJson = (rule: {
    id: number; name: string; prompt: string; enabled: boolean; createdAt: Date; updatedAt: Date;
  }) => ({rule});

  app.get('/api/rules', async (c) => c.json({rules: await listRules(deps.sql)}));

  app.post('/api/rules', async (c) => {
    const body = await c.req.json().catch(() => null) as
      {name?: unknown; prompt?: unknown} | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!name || !prompt) {
      return c.json({error: 'name and prompt must be non-empty strings'}, 400);
    }

    return c.json(ruleJson(await createRule(deps.sql, {name, prompt})), 201);
  });

  app.patch('/api/rules/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({error: 'not found'}, 404);

    const body = await c.req.json().catch(() => null) as
      {name?: unknown; prompt?: unknown; enabled?: unknown} | null;
    if (!body) return c.json({error: 'body must be a JSON object'}, 400);

    const patch: {name?: string; prompt?: string; enabled?: boolean} = {};
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.prompt === 'string' && body.prompt.trim()) patch.prompt = body.prompt.trim();
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (Object.keys(patch).length === 0) return c.json({error: 'nothing to update'}, 400);

    const rule = await updateRule(deps.sql, id, patch);
    if (!rule) return c.json({error: 'not found'}, 404);
    return c.json(ruleJson(rule));
  });

  app.delete('/api/rules/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || !(await deleteRule(deps.sql, id))) {
      return c.json({error: 'not found'}, 404);
    }
    return c.json({deleted: id});
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

  // `since` windows the status counts only. The oldest pending post and the
  // failed list stay current-state: they exist to show a stuck evaluator.
  app.get('/api/stats', async (c) => {
    const sinceDate = parseSince(c.req.query('since'));
    if (sinceDate === 'invalid') return c.json({error: SINCE_INVALID}, 400);

    const [byStatus, subreddits, oldest] = await Promise.all([
      deps.sql<Array<{status: string; count: string}>>`
        SELECT status, COUNT(*)::text AS count FROM posts
         ${sinceDate ? deps.sql`WHERE discovered_at >= ${sinceDate}` : deps.sql``}
         GROUP BY status`,
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
