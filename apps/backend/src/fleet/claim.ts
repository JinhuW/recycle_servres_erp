import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import type postgres from 'postgres';
import {
  cookieUid,
  fleetStateParked,
  totpKey,
  type ClaimAnswer,
  type FleetCookie,
  type FleetDevice,
  type FleetItem,
  type FleetSettings,
  type FleetTaskWhy,
  type HandedTask,
  type NextTaskAnswer,
} from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { log } from '../lib/log';
import { poolKey, seal, sealOrNull, unseal, unsealOrEmpty } from '../lib/sealed';
import { WORKER_ID } from '../routes/coordinator';
import type { Env } from '../types';
import {
  hostAuth, signWorkerToken, workerAuth, workerTokenKey, WORKER_TOKEN_DAYS,
  type HostEnv, type WorkerEnv, type WorkerIdentity,
} from './auth';
import { loadSettings } from './cities';
import { notifyReady } from './scheduler';
import type { FleetHostRow, FleetSlotRow } from './sql';

// ─── The worker protocol ──────────────────────────────────────────────────────
// What a worker container says to the ERP over its life: it claims a slot at
// boot (one pool account with its proxy, device and a fresh lease epoch), then
// heartbeats, long-polls for the next due city, reports what it did and hands
// its browser session back. Every call after the claim carries the epoch in
// its token; a slot claimed again elsewhere moves to the next epoch and the
// old worker is refused (fleet/auth.ts), which is what keeps one Facebook
// account out of two browsers.
//
// Secrets leave the database in the claim answer only. Nothing here logs a
// password, cookie, token or proxy login.
//
// Task ids are BIGSERIAL, which postgres.js hands back as strings; every read
// here casts them to int so the wire carries numbers (a few hundred a day will
// not reach 2^31).

type Vars = HostEnv['Variables'] & WorkerEnv['Variables'];
const worker = new Hono<{ Bindings: Env; Variables: Vars }>();

const BAD_REQUEST = { error: 'bad_request' } as const;
const NOT_FOUND = { error: 'not_found' } as const;
const UNAUTHORIZED = { error: 'unauthorized' } as const;

// Holds past this answer null at once rather than pin another connection; a
// fleet of forty workers never gets near it.
export const MAX_HOLDS = 200;
// A worker idles this long before asking again when there is nothing due; a
// budget or quarantine does not clear in seconds.
const RETRY_NOTHING_DUE = 30;
const RETRY_BLOCKED = 300;
const MAX_COOKIES = 200;
const MAX_DETAIL_BYTES = 64 * 1024;
const DEVICE_COOKIE_DAYS = 400;
const HTTP_ONLY_COOKIES = new Set(['xs', 'datr', 'sb', 'fr']);

const DEFAULT_DEVICE: FleetDevice = {
  user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  viewport: [1366, 768],
  timezone: 'America/New_York',
  locale: 'en-US',
};

const flog = log.child({ module: 'fleet' });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const minutes = (n: number) => `${n} minutes`;

// ─── Wake-ups ─────────────────────────────────────────────────────────────────
// One LISTEN per pool, on the dedicated connection postgres.js keeps for it,
// fanned out in-process to every held next-task. A notify that lands while
// nobody waits is simply lost; the next poll finds the task anyway.

type Waker = { emitter: EventEmitter; ready: Promise<unknown> };
const wakers = new WeakMap<postgres.Sql, Waker>();
let holds = 0;

function waker(sql: postgres.Sql): Waker {
  let w = wakers.get(sql);
  if (!w) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(MAX_HOLDS + 10);
    const ready = sql.listen('fleet_tasks', (payload) => emitter.emit('task', payload))
      .catch((e: unknown) => { flog.warn('fleet_tasks listener failed', e); });
    w = { emitter, ready };
    wakers.set(sql, w);
  }
  return w;
}

/** Resolves on the next fleet_tasks notify or after `seconds`, whichever first. */
function waitForTask(sql: postgres.Sql, seconds: number): Promise<'notified' | 'timeout'> {
  const { emitter } = waker(sql);
  return new Promise((resolve) => {
    const onTask = () => { clearTimeout(timer); resolve('notified'); };
    const timer = setTimeout(() => { emitter.off('task', onTask); resolve('timeout'); }, seconds * 1000);
    emitter.once('task', onTask);
  });
}

/** Held next-task requests right now, for tests. */
export function openHolds(): number {
  return holds;
}

// ─── Cookies ──────────────────────────────────────────────────────────────────
// The pool row holds the cookie as the page shows it: a header string
// ("c_user=…; xs=…") pasted by a person, or a JSON array once a worker has
// handed its session back. The worker always gets Playwright storage-state
// cookies; a header string is given the attributes a Facebook session has.

function cookieFromRecord(c: Record<string, unknown>): FleetCookie | null {
  if (typeof c.name !== 'string' || !c.name || typeof c.value !== 'string') return null;
  const out: FleetCookie = {
    name: c.name,
    value: c.value,
    domain: typeof c.domain === 'string' && c.domain ? c.domain : '.facebook.com',
    path: typeof c.path === 'string' && c.path ? c.path : '/',
  };
  if (typeof c.expires === 'number' && Number.isFinite(c.expires)) out.expires = c.expires;
  if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
  if (typeof c.secure === 'boolean') out.secure = c.secure;
  if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') out.sameSite = c.sameSite;
  return out;
}

export function cookiesFromText(text: string): FleetCookie[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[') || t.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      return [];
    }
    const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.cookies) ? parsed.cookies : [];
    return (list as unknown[]).filter(isRecord).map(cookieFromRecord).filter((c): c is FleetCookie => c !== null);
  }
  const expires = Math.floor(Date.now() / 1000) + DEVICE_COOKIE_DAYS * 86_400;
  return t.split(';').flatMap((part) => {
    const eq = part.indexOf('=');
    if (eq <= 0) return [];
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) return [];
    return [{
      name, value, domain: '.facebook.com', path: '/', expires,
      httpOnly: HTTP_ONLY_COOKIES.has(name), secure: true, sameSite: 'None' as const,
    }];
  });
}

/** What the pool row stores once a worker has handed its session back. */
export function cookieTextFromList(cookies: FleetCookie[]): string {
  return JSON.stringify(cookies);
}

function parseCookies(v: unknown): FleetCookie[] | null {
  if (!Array.isArray(v) || v.length > MAX_COOKIES) return null;
  const out: FleetCookie[] = [];
  for (const c of v) {
    if (!isRecord(c)) return null;
    const cookie = cookieFromRecord(c);
    if (!cookie) return null;
    out.push(cookie);
  }
  return out;
}

// ─── Claim ────────────────────────────────────────────────────────────────────

type ClaimRow = FleetSlotRow & {
  uid: string;
  password_enc: string | null;
  totp_enc: string | null;
  cookie_enc: string | null;
  token_enc: string | null;
};

function deviceOf(stored: unknown): FleetDevice {
  if (!isRecord(stored)) return DEFAULT_DEVICE;
  const viewport = Array.isArray(stored.viewport) && stored.viewport.length === 2
    && stored.viewport.every((n) => Number.isInteger(n))
    ? (stored.viewport as [number, number]) : DEFAULT_DEVICE.viewport;
  return {
    ...stored,
    user_agent: typeof stored.user_agent === 'string' && stored.user_agent ? stored.user_agent : DEFAULT_DEVICE.user_agent,
    viewport,
    timezone: typeof stored.timezone === 'string' && stored.timezone ? stored.timezone : DEFAULT_DEVICE.timezone,
    locale: typeof stored.locale === 'string' && stored.locale ? stored.locale : DEFAULT_DEVICE.locale,
  };
}

/** `scheme://host:port` of a proxy URL, the login cut out, as fb_worker_accounts names it. */
function proxyWithoutLogin(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

async function loadItems(sql: SqlLike): Promise<FleetItem[]> {
  return sql<FleetItem[]>`SELECT name, phrases, filters, enabled FROM fleet_items WHERE enabled ORDER BY name`;
}

worker.post('/claim', hostAuth, async (c) => {
  const host: FleetHostRow = c.var.host;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json(BAD_REQUEST, 422);
  const { host_id, worker_id, version, vnc_port } = body;
  if (host_id !== host.host_id) return c.json({ ...BAD_REQUEST, detail: 'host_id is not the token\'s host' }, 422);
  if (typeof worker_id !== 'string' || !WORKER_ID.test(worker_id)) return c.json({ ...BAD_REQUEST, detail: 'worker_id' }, 422);
  if (typeof version !== 'string' || version.length > 64) return c.json({ ...BAD_REQUEST, detail: 'version' }, 422);
  if (vnc_port !== null && vnc_port !== undefined
    && !(Number.isInteger(vnc_port) && (vnc_port as number) > 0 && (vnc_port as number) < 65536)) {
    return c.json({ ...BAD_REQUEST, detail: 'vnc_port' }, 422);
  }
  const vncPort = typeof vnc_port === 'number' ? vnc_port : null;
  const key = poolKey(c.env);
  if (!key) return c.json({ ...UNAUTHORIZED, detail: 'FB_POOL_KEY is not set' }, 401);
  const tokenKey = workerTokenKey(c.env);
  if (!tokenKey) return c.json({ ...UNAUTHORIZED, detail: 'FLEET_WORKER_TOKEN_KEY is not set' }, 401);

  const sql = getDb(c.env);
  const answer = await sql.begin(async (tx): Promise<ClaimAnswer | null> => {
    const settings = await loadSettings(tx);
    // The slot's own row is what the lock holds; the pool row only says the
    // account is still the fleet's. A slot's home cities nobody else is
    // covering right now count in its favour, after the host it last ran on.
    const [row] = await tx<ClaimRow[]>`
      SELECT s.*, a.uid, a.password_enc, a.totp_enc, a.cookie_enc, a.token_enc
      FROM fleet_slots s JOIN fb_pool_accounts a ON a.no = s.account_no
      WHERE a.status = 'fleet' AND (s.lease_expires_at IS NULL OR s.lease_expires_at < NOW())
      ORDER BY (s.last_host_id = ${host.host_id}) DESC NULLS LAST,
        (SELECT COUNT(*) FROM jsonb_array_elements_text(s.home_cities) h(slug)
          WHERE NOT EXISTS (
            SELECT 1 FROM fleet_slots o
            WHERE o.account_no <> s.account_no AND o.worker_id IS NOT NULL
              AND o.lease_expires_at > NOW() AND o.home_cities ? h.slug)) DESC,
        s.account_no
      LIMIT 1
      FOR UPDATE OF s SKIP LOCKED`;
    if (!row) return null;

    const [slot] = await tx<{ epoch: number }[]>`
      UPDATE fleet_slots SET
        epoch = epoch + 1, worker_id = ${worker_id}, host_id = ${host.host_id}, last_host_id = ${host.host_id},
        lease_expires_at = NOW() + ${minutes(settings.lease_minutes)}::interval
      WHERE account_no = ${row.account_no}
      RETURNING epoch`;
    // The pool row's holder is the worker, as "Assign to fleet" sets it; the
    // trigger on fb_pool_accounts closes the previous stint and opens this
    // one, and the ledger says which host did it.
    await tx`
      UPDATE fb_pool_accounts SET
        holder_user_id = NULL, holder_name = ${worker_id},
        held_since = CASE WHEN lower(holder_name) = lower(${worker_id}) THEN held_since ELSE NOW() END,
        updated_at = NOW()
      WHERE no = ${row.account_no}`;
    await tx`
      INSERT INTO fb_pool_events (account_no, actor_id, actor_name, kind, status, detail)
      VALUES (${row.account_no}, NULL, ${`fleet host ${host.host_id}`}, 'assigned', 'fleet', ${worker_id})`;
    const proxyUrl = row.proxy_url ? unseal(row.proxy_url, key) : null;
    const exit = proxyUrl ? proxyWithoutLogin(proxyUrl) : null;
    if (exit) {
      await tx`
        UPDATE fb_worker_accounts SET proxy_url = ${exit}, proxy_known = TRUE
        WHERE account_no = ${row.account_no} AND ended_at IS NULL`;
    }
    await tx`
      INSERT INTO fleet_workers (worker_id, host_id, account_no, epoch, version, vnc_port)
      VALUES (${worker_id}, ${host.host_id}, ${row.account_no}, ${slot.epoch}, ${version}, ${vncPort})
      ON CONFLICT (worker_id) DO UPDATE SET
        host_id = EXCLUDED.host_id, account_no = EXCLUDED.account_no, epoch = EXCLUDED.epoch,
        version = EXCLUDED.version, vnc_port = EXCLUDED.vnc_port`;

    const exp = Math.floor(Date.now() / 1000) + WORKER_TOKEN_DAYS * 86_400;
    const items = await loadItems(tx);
    const token = unsealOrEmpty(row.token_enc, key);
    return {
      worker_token: signWorkerToken({ worker_id, account_no: row.account_no, epoch: slot.epoch, exp }, tokenKey),
      epoch: slot.epoch,
      account: {
        no: row.account_no,
        uid: row.uid,
        password: unsealOrEmpty(row.password_enc, key),
        totp_secret: totpKey(unsealOrEmpty(row.totp_enc, key)),
        cookies: cookiesFromText(unsealOrEmpty(row.cookie_enc, key)),
        token: token || null,
      },
      proxy: proxyUrl ? { url: proxyUrl } : null,
      device: deviceOf(row.device),
      home_cities: Array.isArray(row.home_cities) ? row.home_cities : [],
      items,
      settings: {
        search: settings.search,
        coordinator_url: c.env.FLEET_COORDINATOR_URL || null,
        lease_minutes: settings.lease_minutes,
        poll_hold_seconds: settings.poll_hold_seconds,
      },
    };
  });
  if (!answer) return c.json({ error: 'no_slot' }, 409);
  flog.info('fleet slot claimed', {
    accountNo: answer.account.no, workerId: worker_id, hostId: host.host_id, epoch: answer.epoch,
    homeCities: answer.home_cities.length, cookies: answer.account.cookies.length, proxy: answer.proxy !== null,
  });
  return c.json(answer);
});

// ─── Heartbeat ────────────────────────────────────────────────────────────────

/** Puts a worker's leased tasks back on the queue; the ids it returned. */
async function releaseTasks(
  tx: SqlLike, where: { worker_id: string } | { account_no: number }, reason: string,
): Promise<number[]> {
  const rows = await tx<{ id: number; item: string }[]>`
    UPDATE fleet_tasks SET
      state = 'ready', due_at = NOW(), worker_id = NULL, epoch = NULL, leased_at = NULL, lease_expires_at = NULL,
      account_no = CASE WHEN kind = 'probe' THEN account_no ELSE NULL END
    WHERE state = 'leased'
      AND ${'worker_id' in where ? tx`worker_id = ${where.worker_id}` : tx`account_no = ${where.account_no}`}
    RETURNING id::int AS id, item`;
  for (const r of rows) {
    await tx`
      INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
      VALUES (${r.id}, ${'worker_id' in where ? where.worker_id : null}, 'released', ${tx.json({ reason })})`;
    await notifyReady(tx, [r.item]);
  }
  return rows.map((r) => r.id);
}

export { releaseTasks };

worker.post('/heartbeat', workerAuth, async (c) => {
  const w: WorkerIdentity = c.var.worker;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.state !== 'string' || !body.state || body.state.length > 40) {
    return c.json({ ...BAD_REQUEST, detail: 'state' }, 422);
  }
  const state = body.state;
  const version = typeof body.version === 'string' ? body.version.slice(0, 64) : null;
  const vncPort = Number.isInteger(body.vnc_port) ? (body.vnc_port as number) : null;
  const detail = isRecord(body.detail) && JSON.stringify(body.detail).length <= MAX_DETAIL_BYTES ? body.detail : null;
  const lastSearch = typeof body.last_search_at === 'string' ? body.last_search_at : null;

  const sql = getDb(c.env);
  const detailValue: postgres.JSONValue | null = detail || lastSearch
    ? ({ ...(detail ?? {}), ...(lastSearch ? { last_search_at: lastSearch } : {}) } as postgres.JSONValue)
    : null;
  await sql.begin(async (tx) => {
    const settings = await loadSettings(tx);
    const lease = tx`NOW() + ${minutes(settings.lease_minutes)}::interval`;
    await tx`
      UPDATE fleet_slots SET lease_expires_at = ${lease}
      WHERE account_no = ${w.account_no} AND epoch = ${w.epoch}`;
    await tx`
      INSERT INTO fleet_workers (worker_id, host_id, account_no, epoch, state, version, last_heartbeat_at, vnc_port, detail)
      VALUES (${w.worker_id}, ${w.slot.host_id}, ${w.account_no}, ${w.epoch}, ${state}, ${version}, NOW(), ${vncPort},
              ${detailValue === null ? null : tx.json(detailValue)})
      ON CONFLICT (worker_id) DO UPDATE SET
        host_id = EXCLUDED.host_id, account_no = EXCLUDED.account_no, epoch = EXCLUDED.epoch, state = EXCLUDED.state,
        version = COALESCE(EXCLUDED.version, fleet_workers.version), last_heartbeat_at = NOW(),
        vnc_port = COALESCE(EXCLUDED.vnc_port, fleet_workers.vnc_port), detail = EXCLUDED.detail`;
    if (state === 'HEALTHY') {
      await tx`
        UPDATE fleet_tasks SET lease_expires_at = ${lease}
        WHERE worker_id = ${w.worker_id} AND epoch = ${w.epoch} AND state = 'leased'`;
    } else if (fleetStateParked(state)) {
      // A parked account cannot search: its city goes back to the queue now,
      // not when the lease runs out. DEGRADED keeps it (the search goes on).
      const released = await releaseTasks(tx, { worker_id: w.worker_id }, state);
      if (released.length) flog.info('fleet tasks released by a parked worker', { workerId: w.worker_id, state, tasks: released });
    }
  });
  return c.json({ ok: true, directives: [] });
});

// ─── Next task ────────────────────────────────────────────────────────────────

type PickRow = {
  id: number; kind: HandedTask['kind']; city: string; name: string; radius_km: number; item: string;
  reason: string | null; lease_expires_at: Date; home: boolean; familiar: boolean;
};

type Pick = NextTaskAnswer | { stale: true };

function why(r: PickRow): FleetTaskWhy {
  if (r.kind === 'probe') return 'probe';
  if (r.reason === 'manual') return 'manual';
  if (r.home) return 'home';
  if (r.familiar) return 'familiar';
  return 'other';
}

/**
 * One transaction: close what the worker finished, then take the best due
 * task for this account. Several backend instances and forty workers pick at
 * once, so the row is locked as it is chosen and a locked one is skipped.
 */
async function pickTask(
  sql: postgres.Sql, w: WorkerIdentity, settings: FleetSettings,
  done: { task_id: number; result: Record<string, unknown> } | null,
  take = true,
): Promise<Pick> {
  return sql.begin(async (tx): Promise<Pick> => {
    // The hold may have lasted a minute: the slot could have moved on.
    const [slot] = await tx<{ epoch: number; quarantined_until: Date | null; home_cities: string[] }[]>`
      SELECT epoch, quarantined_until, home_cities FROM fleet_slots WHERE account_no = ${w.account_no}`;
    if (!slot || slot.epoch !== w.epoch) return { stale: true };

    if (done) {
      const closed = await tx<{ id: number }[]>`
        UPDATE fleet_tasks SET state = 'done', done_at = NOW(), result = ${tx.json(done.result as postgres.JSONValue)}
        WHERE id = ${done.task_id} AND worker_id = ${w.worker_id} AND state = 'leased'
        RETURNING id::int AS id`;
      if (closed.length) {
        await tx`
          INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
          VALUES (${done.task_id}, ${w.worker_id}, 'done', ${tx.json(done.result as postgres.JSONValue)})`;
      }
    }
    if (!take) return { task: null, reason: 'done_only' };

    const quarantined = slot.quarantined_until !== null && slot.quarantined_until.getTime() > Date.now();
    if (!quarantined) {
      const [used] = await tx<{ minutes: number | null }[]>`
        SELECT minutes::float8 AS minutes FROM fleet_minutes
        WHERE account_no = ${w.account_no} AND day = (NOW() AT TIME ZONE 'UTC')::date`;
      if ((used?.minutes ?? 0) >= settings.budget_minutes) {
        return { task: null, retry_after: RETRY_BLOCKED, reason: 'budget' };
      }
    }
    const home = Array.isArray(slot.home_cities) ? slot.home_cities : [];
    // A quarantined account only probes its own slot; everyone else takes
    // searches and slug checks, plus a probe aimed at them whose quarantine
    // has lapsed meanwhile.
    const kinds = quarantined
      ? tx`t.kind = 'probe' AND t.account_no = ${w.account_no}`
      : tx`(t.kind <> 'probe' OR t.account_no = ${w.account_no})`;
    const [row] = await tx<PickRow[]>`
      SELECT t.id::int AS id, t.kind, t.city, c.name, c.radius_km, t.item, t.reason, t.lease_expires_at,
        (t.city = ANY(${home}::text[])) AS home,
        EXISTS (SELECT 1 FROM fleet_tasks f
                WHERE f.account_no = ${w.account_no} AND f.city = t.city AND f.state = 'done'
                  AND f.done_at > NOW() - ${`${settings.familiar_days} days`}::interval) AS familiar
      FROM fleet_tasks t JOIN fleet_cities c ON c.slug = t.city
      WHERE t.state = 'ready' AND t.due_at <= NOW() AND ${kinds}
      ORDER BY t.priority DESC,
        CASE WHEN t.city = ANY(${home}::text[]) THEN 0
             WHEN EXISTS (SELECT 1 FROM fleet_tasks f
                          WHERE f.account_no = ${w.account_no} AND f.city = t.city AND f.state = 'done'
                            AND f.done_at > NOW() - ${`${settings.familiar_days} days`}::interval) THEN 1
             ELSE 2 END,
        t.due_at
      LIMIT 1
      FOR UPDATE OF t SKIP LOCKED`;
    if (!row) {
      return quarantined
        ? { task: null, retry_after: RETRY_BLOCKED, reason: 'quarantined' }
        : { task: null, retry_after: RETRY_NOTHING_DUE, reason: 'nothing_due' };
    }
    const [leased] = await tx<{ lease_expires_at: Date }[]>`
      UPDATE fleet_tasks SET
        state = 'leased', worker_id = ${w.worker_id}, account_no = ${w.account_no}, epoch = ${w.epoch},
        leased_at = NOW(), lease_expires_at = NOW() + ${minutes(settings.lease_minutes)}::interval
      WHERE id = ${row.id}
      RETURNING lease_expires_at`;
    const reason = why(row);
    await tx`
      INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
      VALUES (${row.id}, ${w.worker_id}, 'handed', ${tx.json({ why: reason })})`;
    return {
      task: {
        id: row.id,
        kind: row.kind,
        city: { slug: row.city, name: row.name, radius_km: row.radius_km },
        item: row.item,
        lease_expires_at: leased.lease_expires_at.toISOString(),
        why: reason,
      },
    };
  });
}

worker.post('/next-task', workerAuth, async (c) => {
  const w: WorkerIdentity = c.var.worker;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json(BAD_REQUEST, 422);
  let done: { task_id: number; result: Record<string, unknown> } | null = null;
  if (body.done !== null && body.done !== undefined) {
    if (!isRecord(body.done) || !Number.isInteger(body.done.task_id)) return c.json({ ...BAD_REQUEST, detail: 'done' }, 422);
    const result = isRecord(body.done.result) ? body.done.result : {};
    if (JSON.stringify(result).length > MAX_DETAIL_BYTES) return c.json({ ...BAD_REQUEST, detail: 'done.result' }, 422);
    done = { task_id: body.done.task_id as number, result };
  }
  if (body.take !== undefined && typeof body.take !== 'boolean') return c.json({ ...BAD_REQUEST, detail: 'take' }, 422);
  const take = body.take !== false;
  const sql = getDb(c.env);
  const settings = await loadSettings(sql);
  const wait = typeof body.wait === 'number' && Number.isFinite(body.wait) ? body.wait : settings.poll_hold_seconds;
  const hold = Math.max(0, Math.min(wait, settings.poll_hold_seconds));

  // The listener is up before the first look, so a task written between the
  // look and the hold still wakes it.
  if (take && hold > 0) await waker(sql).ready;
  let answer = await pickTask(sql, w, settings, done, take);
  if ('stale' in answer) return c.json({ error: 'stale_epoch' }, 409);
  if (answer.task || answer.reason !== 'nothing_due' || hold === 0) return c.json(answer);
  if (holds >= MAX_HOLDS) return c.json(answer);

  holds++;
  try {
    await waitForTask(sql, hold);
  } finally {
    holds--;
  }
  answer = await pickTask(sql, w, settings, null);
  if ('stale' in answer) return c.json({ error: 'stale_epoch' }, 409);
  return c.json(answer);
});

// ─── Events ───────────────────────────────────────────────────────────────────

const EVENT_KINDS = new Set(['started', 'searched', 'finished', 'stopped']);

worker.post('/events', workerAuth, async (c) => {
  const w: WorkerIdentity = c.var.worker;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.task_id)) return c.json({ ...BAD_REQUEST, detail: 'task_id' }, 422);
  if (typeof body.kind !== 'string' || !EVENT_KINDS.has(body.kind)) return c.json({ ...BAD_REQUEST, detail: 'kind' }, 422);
  const detail = body.detail === undefined || body.detail === null ? null : isRecord(body.detail) ? body.detail : undefined;
  if (detail === undefined || (detail && JSON.stringify(detail).length > MAX_DETAIL_BYTES)) {
    return c.json({ ...BAD_REQUEST, detail: 'detail' }, 422);
  }
  const kind = body.kind;
  const sql = getDb(c.env);
  const [task] = await sql<{ id: number; kind: string; city: string; worker_id: string | null }[]>`
    SELECT id::int AS id, kind, city, worker_id FROM fleet_tasks WHERE id = ${body.task_id as number}`;
  if (!task || task.worker_id !== w.worker_id) return c.json(NOT_FOUND, 404);

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
      VALUES (${task.id}, ${w.worker_id}, ${kind}, ${detail ? tx.json(detail as postgres.JSONValue) : null})`;
    if (kind === 'started') {
      await tx`UPDATE fleet_tasks SET started_at = COALESCE(started_at, NOW()) WHERE id = ${task.id}`;
    }
    // A slug check's verdict is the city's: it searches only once Facebook
    // showed the place the manager meant.
    if (task.kind === 'verify-slug' && (kind === 'finished' || kind === 'stopped')) {
      const matches = detail?.matches === true;
      const location = typeof detail?.location === 'string' ? detail.location.slice(0, 200) : null;
      await tx`
        UPDATE fleet_cities SET
          verified_at = NOW(), verified_as = ${location}, enabled = ${matches},
          disabled_at = CASE WHEN ${matches} THEN NULL ELSE disabled_at END
        WHERE slug = ${task.city}`;
      flog.info('fleet city slug verified', { city: task.city, matches, location, workerId: w.worker_id });
    }
  });
  return c.json({ ok: true });
});

// ─── Session ──────────────────────────────────────────────────────────────────

worker.put('/session', workerAuth, async (c) => {
  const w: WorkerIdentity = c.var.worker;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const cookies = body ? parseCookies(body.cookies) : null;
  if (!cookies) return c.json({ ...BAD_REQUEST, detail: 'cookies' }, 422);
  const token = body!.token;
  if (token !== undefined && token !== null && (typeof token !== 'string' || token.length > 4096)) {
    return c.json({ ...BAD_REQUEST, detail: 'token' }, 422);
  }
  const key = poolKey(c.env);
  if (!key) return c.json({ ...UNAUTHORIZED, detail: 'FB_POOL_KEY is not set' }, 401);
  const text = cookieTextFromList(cookies);
  const sql = getDb(c.env);
  const updated = await sql<{ no: number }[]>`
    UPDATE fb_pool_accounts SET
      cookie_enc = ${cookies.length ? seal(text, key) : null}, cookie_uid = ${cookies.length ? cookieUid(text) : null},
      cookie_at = NOW(), updated_at = NOW(),
      token_enc = ${token === undefined ? sql`token_enc` : sealOrNull(token ?? '', key)}
    WHERE no = ${w.account_no}
    RETURNING no`;
  if (!updated.length) return c.json(NOT_FOUND, 404);
  flog.info('fleet session resealed', { accountNo: w.account_no, workerId: w.worker_id, cookies: cookies.length, token: token !== undefined });
  return c.json({ ok: true });
});

// ─── VNC ──────────────────────────────────────────────────────────────────────
// The handshake only: fleet/vnc.ts owns the socket and replays the upgrade
// through here so the worker's token gates it like any other call.

worker.get('/vnc', workerAuth, (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'Expected a WebSocket upgrade' }, 426);
  }
  c.header('X-Fleet-Worker-Id', c.var.worker.worker_id);
  return c.body(null, 204);
});

export default worker;
