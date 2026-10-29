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
  type FleetStorageState,
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
  claimAuth, eligibleSlot, signWorkerToken, unavailable, workerAuth, workerTokenKey, WORKER_TOKEN_DAYS,
  type ClaimEnv, type WorkerEnv, type WorkerIdentity,
} from './auth';
import { loadSettings } from './cities';
import { notifyReady } from './scheduler';
import { minutesTodaySql, type ClaimTicketRow, type FleetHostRow, type FleetSlotRow } from './sql';
import { loadRelease, ownWorkerId } from './hosts';

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

type Vars = ClaimEnv['Variables'] & WorkerEnv['Variables'];
const worker = new Hono<{ Bindings: Env; Variables: Vars }>();

const BAD_REQUEST = { error: 'bad_request' } as const;
const NOT_FOUND = { error: 'not_found' } as const;

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
// fanned out in-process to every held next-task. Each poll arms its own
// listener before its first look, so a task committed between that look and
// the hold still wakes it.

type Waker = { emitter: EventEmitter; ready: Promise<unknown> };
const wakers = new WeakMap<postgres.Sql, Waker>();
let holds = 0;

function waker(sql: postgres.Sql): Waker {
  let w = wakers.get(sql);
  if (!w) {
    const emitter = new EventEmitter();
    // Armed polls, held or about to look: at most one per open request.
    emitter.setMaxListeners(0);
    const ready = sql.listen('fleet_tasks', (payload) => emitter.emit('task', payload))
      .catch((e: unknown) => {
        // Forget it so the next poll listens again, rather than every hold
        // sleeping out its time for the life of the process.
        wakers.delete(sql);
        flog.warn('fleet_tasks listener failed', e);
      });
    w = { emitter, ready };
    wakers.set(sql, w);
  }
  return w;
}

type Wake = { wait: (ms: number) => Promise<void>; dispose: () => void };

/** Starts listening now; `wait` resolves at once if a notify already came. */
function armWake(sql: postgres.Sql): Wake {
  const { emitter } = waker(sql);
  let fired = false;
  let release: (() => void) | null = null;
  const onTask = () => { fired = true; release?.(); };
  emitter.on('task', onTask);
  return {
    wait: (ms) => new Promise<void>((resolve) => {
      if (fired) return resolve();
      const timer = setTimeout(() => { release = null; resolve(); }, ms);
      release = () => { clearTimeout(timer); release = null; resolve(); };
    }),
    dispose: () => { emitter.off('task', onTask); },
  };
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
  if (typeof c.partitionKey === 'string') out.partitionKey = c.partitionKey;
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

function parseStorageState(value: unknown): FleetStorageState | null {
  if (!isRecord(value) || !Array.isArray(value.origins)) return null;
  const cookies = parseCookies(value.cookies);
  if (!cookies) return null;
  for (const origin of value.origins) {
    if (!isRecord(origin) || typeof origin.origin !== 'string' || !Array.isArray(origin.localStorage)) return null;
    try {
      const url = new URL(origin.origin);
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin.origin) return null;
    } catch { return null; }
    if (!origin.localStorage.every((item: unknown) => isRecord(item)
      && typeof item.name === 'string' && typeof item.value === 'string')) return null;
    if (origin.indexedDB !== undefined && (!Array.isArray(origin.indexedDB) || !origin.indexedDB.every(isRecord))) return null;
  }
  return { cookies, origins: value.origins as FleetStorageState['origins'] };
}

export function storageStateFromText(text: string): FleetStorageState {
  if (text.trim().startsWith('{')) {
    const value: unknown = JSON.parse(text);
    const state = parseStorageState(value);
    if (!state) throw new Error('Invalid stored browser session');
    return state;
  }
  return { cookies: cookiesFromText(text), origins: [] };
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
export function proxyWithoutLogin(url: string): string | null {
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

const CLAIM_SELECT = (tx: SqlLike) => tx`
  SELECT s.*, a.uid, a.password_enc, a.totp_enc, a.cookie_enc, a.token_enc
  FROM fleet_slots s JOIN fb_pool_accounts a ON a.no = s.account_no`;

type TicketRefusal = 'used_ticket' | 'expired_ticket';

worker.post('/claim', claimAuth, async (c) => {
  const host: FleetHostRow = c.var.host;
  const ticket: ClaimTicketRow | null = c.var.ticket;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json(BAD_REQUEST, 422);
  const { host_id, worker_id, version, vnc_port } = body;
  if (host_id !== host.host_id) return c.json({ ...BAD_REQUEST, detail: 'host_id is not the token\'s host' }, 422);
  if (typeof worker_id !== 'string' || !WORKER_ID.test(worker_id) || !ownWorkerId(host.host_id, worker_id)) {
    return c.json({ ...BAD_REQUEST, detail: 'worker_id must be <host_id>-<n>' }, 422);
  }
  if (typeof version !== 'string' || version.length > 64) return c.json({ ...BAD_REQUEST, detail: 'version' }, 422);
  if (vnc_port !== null && vnc_port !== undefined
    && !(Number.isInteger(vnc_port) && (vnc_port as number) > 0 && (vnc_port as number) < 65536)) {
    return c.json({ ...BAD_REQUEST, detail: 'vnc_port' }, 422);
  }
  const vncPort = typeof vnc_port === 'number' ? vnc_port : null;
  const key = poolKey(c.env);
  if (!key) return c.json(unavailable('FB_POOL_KEY'), 503);
  const tokenKey = workerTokenKey(c.env);
  if (!tokenKey) return c.json(unavailable('FLEET_WORKER_TOKEN_KEY'), 503);

  if ((body.claim_id !== undefined && (typeof body.claim_id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(body.claim_id)))
      || (body.handoff_epoch !== undefined && (!Number.isInteger(body.handoff_epoch) || (body.handoff_epoch as number) < 0))) return c.json(BAD_REQUEST, 422);
  const claimId = typeof body.claim_id === 'string' ? body.claim_id : null;
  const handoff = Number.isInteger(body.handoff_epoch) ? body.handoff_epoch as number : null;
  if (ticket && (ticket.worker_id !== worker_id || ticket.handoff_epoch !== handoff)) {
    return c.json({ error: 'unauthorized', detail: 'ticket_mismatch' }, 401);
  }
  const sql = getDb(c.env);
  const answer = await sql.begin(async (tx): Promise<ClaimAnswer | TicketRefusal | null> => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${host.host_id + ':' + worker_id}, 0))`;
    if (ticket) {
      // Spent by its first claim; only that boot's own retries (its claim_id)
      // get through after, and none once it expires.
      const [t] = await tx<ClaimTicketRow[]>`SELECT * FROM fleet_claim_tickets WHERE token_hash = ${ticket.token_hash} FOR UPDATE`;
      if (!t) return 'used_ticket';
      if (t.expires_at.getTime() <= Date.now()) return 'expired_ticket';
      if (t.consumed_at !== null && (claimId === null || t.claim_id !== claimId)) return 'used_ticket';
    }
    const [running] = await tx`SELECT account_no FROM fleet_slots WHERE host_id = ${host.host_id} AND worker_id = ${worker_id}
      AND lease_expires_at > NOW()
      AND NOT ((${claimId}::text IS NOT NULL AND claim_id IS NOT DISTINCT FROM ${claimId})
        OR (${handoff}::int IS NOT NULL AND handoff_epoch IS NOT DISTINCT FROM ${handoff} AND reserved_until > NOW()))`;
    if (running) return null;
    const settings = await loadSettings(tx);

    // This boot's own slot (a retried claim) or the one held for it (a
    // handoff) waits for its lock: skipping it would hand the same boot a
    // second account while the first sits leased.
    let row: ClaimRow | undefined;
    if (claimId !== null || handoff !== null) {
      const [mine] = await tx<{ account_no: number }[]>`
        SELECT account_no FROM fleet_slots WHERE host_id = ${host.host_id} AND worker_id = ${worker_id}
          AND ((${claimId}::text IS NOT NULL AND claim_id = ${claimId})
            OR (${handoff}::int IS NOT NULL AND handoff_epoch = ${handoff} AND reserved_until > NOW()))
        ORDER BY (claim_id IS NOT DISTINCT FROM ${claimId}) DESC LIMIT 1`;
      if (mine) {
        [row] = await tx<ClaimRow[]>`${CLAIM_SELECT(tx)} WHERE s.account_no = ${mine.account_no} AND a.status = 'fleet'
          FOR NO KEY UPDATE OF a`;
      }
    }
    // Otherwise any free slot. A handoff whose reservation lapsed lands here
    // too, and its own slot (now free) still comes first.
    // The slot's own row is what the lock holds; the pool row only says the
    // account is still the fleet's.
    if (!row) {
      [row] = await tx<ClaimRow[]>`
        ${CLAIM_SELECT(tx)}
        WHERE a.status = 'fleet' AND (s.lease_expires_at IS NULL OR s.lease_expires_at < NOW())
        ORDER BY (s.worker_id = ${worker_id}) DESC NULLS LAST,
          (s.last_host_id = ${host.host_id}) DESC NULLS LAST,
          s.account_no
        LIMIT 1
        FOR NO KEY UPDATE OF a SKIP LOCKED`;
    }
    if (!row) return null;

    const [locked] = await tx<(FleetSlotRow & { reserved: boolean; free: boolean })[]>`
      SELECT *, COALESCE(reserved_until > NOW(), FALSE) AS reserved,
        (lease_expires_at IS NULL OR lease_expires_at < NOW()) AS free
      FROM fleet_slots WHERE account_no = ${row.account_no} FOR UPDATE`;
    const ours = locked.worker_id === worker_id && locked.host_id === host.host_id;
    const repeated = claimId !== null && locked.claim_id === claimId && ours;
    const handedOff = !repeated && handoff !== null && locked.handoff_epoch === handoff && ours && locked.reserved;
    if (!repeated && !handedOff && !locked.free) return null;
    let epoch = locked.epoch;
    if (!repeated) {
      // The pool trigger fences the previous holder before the new lease is installed.
      await tx`UPDATE fb_pool_accounts SET holder_user_id = NULL, holder_name = ${worker_id},
        held_since = CASE WHEN lower(holder_name) = lower(${worker_id}) THEN held_since ELSE NOW() END,
        updated_at = NOW() WHERE no = ${row.account_no}`;
      const [slot] = await tx<{ epoch: number }[]>`
        UPDATE fleet_slots SET epoch = ${locked.epoch + 1}, worker_id = ${worker_id}, host_id = ${host.host_id},
          last_host_id = ${host.host_id}, claim_id = ${claimId}, handoff_epoch = ${handedOff ? handoff : null},
          reserved_until = NULL, lease_expires_at = NOW() + ${minutes(settings.lease_minutes)}::interval
        WHERE account_no = ${row.account_no} RETURNING epoch`;
      epoch = slot.epoch;
      await tx`INSERT INTO fb_pool_events (account_no, actor_id, actor_name, kind, status, detail)
        VALUES (${row.account_no}, NULL, ${`fleet host ${host.host_id}`}, 'assigned', 'fleet', ${worker_id})`;
    }
    const proxyUrl = row.proxy_url ? unseal(row.proxy_url, key) : null;
    const exit = proxyUrl ? proxyWithoutLogin(proxyUrl) : null;
    if (exit) {
      await tx`
        UPDATE fb_worker_accounts SET proxy_url = ${exit}, proxy_known = TRUE
        WHERE account_no = ${row.account_no} AND ended_at IS NULL`;
    }
    if (!repeated) await tx`
      INSERT INTO fleet_workers (worker_id, host_id, account_no, epoch, version, vnc_port)
      VALUES (${worker_id}, ${host.host_id}, ${row.account_no}, ${epoch}, ${version}, ${vncPort})
      ON CONFLICT (worker_id) DO UPDATE SET
        host_id = EXCLUDED.host_id, account_no = EXCLUDED.account_no, epoch = EXCLUDED.epoch,
        version = EXCLUDED.version, vnc_port = EXCLUDED.vnc_port, state = NULL, last_heartbeat_at = NULL, detail = NULL,
        relogin_id = NULL, relogin_requested_at = NULL, relogin_requested_by = NULL, relogin_delivered_at = NULL,
        resume_id = NULL, resume_requested_at = NULL, resume_requested_by = NULL, resume_delivered_at = NULL`;

    if (ticket) {
      await tx`UPDATE fleet_claim_tickets SET consumed_at = COALESCE(consumed_at, NOW()), claim_id = ${claimId}
        WHERE token_hash = ${ticket.token_hash}`;
    }
    const exp = Math.floor(Date.now() / 1000) + WORKER_TOKEN_DAYS * 86_400;
    const items = await loadItems(tx);
    const token = unsealOrEmpty(row.token_enc, key);
    const storageState = storageStateFromText(unsealOrEmpty(row.cookie_enc, key));
    return {
      worker_token: signWorkerToken({ worker_id, account_no: row.account_no, epoch, exp }, tokenKey),
      epoch,
      account: {
        no: row.account_no,
        uid: row.uid,
        password: unsealOrEmpty(row.password_enc, key),
        totp_secret: totpKey(unsealOrEmpty(row.totp_enc, key)),
        cookies: storageState.cookies,
        storage_state: storageState,
        token: token || null,
      },
      proxy: proxyUrl ? { url: proxyUrl } : null,
      device: deviceOf(row.device),
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
  if (typeof answer === 'string') return c.json({ error: 'unauthorized', detail: answer }, 401);
  flog.info('fleet slot claimed', {
    accountNo: answer.account.no, workerId: worker_id, hostId: host.host_id, epoch: answer.epoch, by: ticket ? 'ticket' : 'host_token',
    cookies: answer.account.cookies.length, proxy: answer.proxy !== null,
  });
  return c.json(answer);
});

// ─── Heartbeat ────────────────────────────────────────────────────────────────

/** Puts a worker's leased tasks back on the queue; the ids it returned. */
async function releaseTasks(
  tx: SqlLike, where: { worker_id: string; account_no?: number; epoch?: number } | { account_no: number }, reason: string,
): Promise<number[]> {
  const rows = await tx<{ id: number; item: string }[]>`
    UPDATE fleet_tasks SET
      state = 'ready', due_at = NOW(), worker_id = NULL, epoch = NULL, leased_at = NULL, lease_expires_at = NULL, started_at = NULL,
      account_no = CASE WHEN kind = 'probe' THEN account_no ELSE NULL END
    WHERE state = 'leased'
      AND ${'worker_id' in where ? tx`worker_id = ${where.worker_id}` : tx`account_no = ${where.account_no}`}
      ${'worker_id' in where && where.account_no !== undefined ? tx`AND account_no = ${where.account_no}` : tx``}
      ${'epoch' in where ? tx`AND epoch = ${where.epoch!}` : tx``}
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

/** Deletes an account's slot with what it held: its leased tasks go back on
 *  the queue (the pool trigger only does that for an account leaving
 *  `fleet`), and its quarantine probe, which nothing else would close, is
 *  cancelled. False when it had no slot. */
export async function dropSlot(tx: SqlLike, no: number, reason: string): Promise<boolean> {
  const [slot] = await tx<{ account_no: number }[]>`SELECT account_no FROM fleet_slots WHERE account_no = ${no} FOR UPDATE`;
  if (!slot) return false;
  await releaseTasks(tx, { account_no: no }, reason);
  await tx`UPDATE fleet_tasks SET state = 'cancelled', done_at = NOW() WHERE account_no = ${no} AND kind = 'probe' AND state = 'ready'`;
  await tx`DELETE FROM fleet_slots WHERE account_no = ${no}`;
  return true;
}

worker.post('/heartbeat', workerAuth, async (c) => {
  const w: WorkerIdentity = c.var.worker;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.state !== 'string' || !body.state || body.state.length > 40) {
    return c.json({ ...BAD_REQUEST, detail: 'state' }, 422);
  }
  const state = body.state;
  const version = typeof body.version === 'string' ? body.version.slice(0, 64) : null;
  const vncPort = Number.isInteger(body.vnc_port) && (body.vnc_port as number) > 0 && (body.vnc_port as number) < 65536
    ? (body.vnc_port as number) : null;
  const detail = isRecord(body.detail) && JSON.stringify(body.detail).length <= MAX_DETAIL_BYTES ? body.detail : null;
  const lastSearch = typeof body.last_search_at === 'string' && body.last_search_at.length <= 64 ? body.last_search_at : null;

  const sql = getDb(c.env);
  const detailValue: postgres.JSONValue | null = detail || lastSearch
    ? ({ ...(detail ?? {}), ...(lastSearch ? { last_search_at: lastSearch } : {}) } as postgres.JSONValue)
    : null;
  const accepted = await sql.begin(async (tx): Promise<false | { relogin: string | null; resume: string | null }> => {
    if (!await eligibleSlot(tx, w, true)) return false;
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
    // The worker acts on `relogin` and `resume` only when one first appears,
    // so each goes out on exactly one answer.
    const [relogin] = await tx<{ relogin_id: string }[]>`
      UPDATE fleet_workers SET relogin_delivered_at = NOW()
      WHERE worker_id = ${w.worker_id} AND relogin_id IS NOT NULL AND relogin_delivered_at IS NULL
      RETURNING relogin_id`;
    const [resume] = await tx<{ resume_id: string }[]>`
      UPDATE fleet_workers SET resume_delivered_at = NOW()
      WHERE worker_id = ${w.worker_id} AND resume_id IS NOT NULL AND resume_delivered_at IS NULL
      RETURNING resume_id`;
    if (fleetStateParked(state)) {
      // A parked account cannot search: its city goes back to the queue now,
      // not when the lease runs out.
      const released = await releaseTasks(tx, { worker_id: w.worker_id, account_no: w.account_no, epoch: w.epoch }, state);
      if (released.length) flog.info('fleet tasks released by a parked worker', { workerId: w.worker_id, state, tasks: released });
    } else {
      // Any other state (HEALTHY, DEGRADED, …) is still searching: renewing
      // only on HEALTHY let a search that turned DEGRADED expire mid-run, a
      // second account search the same city and the first one's done drop.
      // Never past task_max_minutes, where reconcile returns it anyway.
      await tx`
        UPDATE fleet_tasks SET lease_expires_at = LEAST(${lease}, leased_at + make_interval(mins => ${settings.task_max_minutes}))
        WHERE worker_id = ${w.worker_id} AND account_no = ${w.account_no} AND epoch = ${w.epoch} AND state = 'leased'`;
    }
    return { relogin: relogin?.relogin_id ?? null, resume: resume?.resume_id ?? null };
  });
  if (!accepted) return c.json({ error: 'stale_epoch' }, 409);
  // Re-signed with a day left, or at once when it verified under the
  // previous key, so a key rotation drains within one heartbeat.
  const exp = Math.floor(Date.now() / 1000) + WORKER_TOKEN_DAYS * 86400;
  const renewal = w.rotated || w.exp * 1000 - Date.now() < 86400000
    ? { worker_token: signWorkerToken({ worker_id: w.worker_id, account_no: w.account_no, epoch: w.epoch, exp }, workerTokenKey(c.env)!), token_expires_at: exp }
    : {};
  if (accepted.relogin) flog.info('fleet relogin delivered', { workerId: w.worker_id, reloginId: accepted.relogin, state });
  if (accepted.resume) flog.info('fleet resume delivered', { workerId: w.worker_id, resumeId: accepted.resume, state });
  const directives = {
    directives: [...(accepted.relogin ? ['relogin'] : []), ...(accepted.resume ? ['resume'] : [])],
    ...(accepted.relogin ? { relogin_id: accepted.relogin } : {}),
    ...(accepted.resume ? { resume_id: accepted.resume } : {}),
  };
  return c.json({ ok: true, ...directives, ...renewal });
});

// ─── Next task ────────────────────────────────────────────────────────────────

type PickRow = {
  id: number; kind: HandedTask['kind']; city: string; name: string; radius_km: number; item: string;
  reason: string | null; lease_expires_at: Date; familiar: boolean;
};

type Pick = NextTaskAnswer | { stale: true };

function why(r: PickRow): FleetTaskWhy {
  if (r.kind === 'probe') return 'probe';
  if (r.reason === 'manual') return 'manual';
  if (r.familiar) return 'familiar';
  return 'other';
}

function handed(r: PickRow, leaseExpiresAt: Date): HandedTask {
  return {
    id: r.id,
    kind: r.kind,
    city: { slug: r.city, name: r.name, radius_km: r.radius_km },
    item: r.item,
    lease_expires_at: leaseExpiresAt.toISOString(),
    why: why(r),
  };
}

/** Tasks with the city's name and whether this account searched the city lately. */
function taskRows(tx: SqlLike, w: WorkerIdentity, settings: FleetSettings) {
  return tx`
    WITH familiar AS (
      SELECT DISTINCT city FROM fleet_tasks
      WHERE account_no = ${w.account_no} AND state = 'done'
        AND done_at > NOW() - ${`${settings.familiar_days} days`}::interval
    )
    SELECT t.id::int AS id, t.kind, t.city, c.name, c.radius_km, t.item, t.reason, t.lease_expires_at, t.priority, t.due_at,
      (f.city IS NOT NULL) AS familiar
    FROM fleet_tasks t JOIN fleet_cities c ON c.slug = t.city LEFT JOIN familiar f ON f.city = t.city`;
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
    const slot = await eligibleSlot(tx, w, true);
    if (!slot) return { stale: true };
    // Read under the slot's lock, not a lock of its own. advanceRoll takes
    // the release row and then this slot's lock: a pick that waited here sees
    // the drain it set, and one that got here first has leased before
    // advanceRoll looks for idle workers. Locking the release row made every
    // pick in the fleet wait in one line.
    const release = await loadRelease(tx);

    if (done) {
      const closed = await tx<{ id: number; kind: string }[]>`
        UPDATE fleet_tasks SET state = 'done', done_at = NOW(), result = ${tx.json(done.result as postgres.JSONValue)}
        WHERE id = ${done.task_id} AND worker_id = ${w.worker_id} AND account_no = ${w.account_no} AND epoch = ${w.epoch} AND state = 'leased'
        RETURNING id::int AS id, kind`;
      if (closed.length) {
        if (closed[0].kind === 'probe' && typeof done.result.cards === 'number' && done.result.cards > 0 && !done.result.stopped) {
          await tx`UPDATE fleet_slots SET quarantined_until = NULL, quarantine_reset_at = NOW(), quarantine_evidence = NULL WHERE account_no = ${w.account_no}`;
        }
        await tx`
          INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
          VALUES (${done.task_id}, ${w.worker_id}, 'done', ${tx.json(done.result as postgres.JSONValue)})`;
      }
    }
    if (!take) return { task: null, reason: 'done_only' };

    // A lease this epoch still holds was handed in an answer the worker never
    // got (a timeout, a dropped connection): hand it again rather than lease a
    // second one. Otherwise the first sits leased, renewed by every HEALTHY
    // heartbeat until task_max_minutes, its city blocked and its minutes
    // charged alongside the new task's.
    const [held] = await tx<PickRow[]>`
      ${taskRows(tx, w, settings)}
      WHERE t.state = 'leased' AND t.worker_id = ${w.worker_id} AND t.account_no = ${w.account_no} AND t.epoch = ${w.epoch}
      ORDER BY t.leased_at DESC LIMIT 1`;
    if (held) {
      await tx`
        INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
        VALUES (${held.id}, ${w.worker_id}, 'handed', ${tx.json({ why: why(held), again: true })})`;
      return { task: handed(held, held.lease_expires_at) };
    }

    // The worker a roll is replacing finishes what it has and takes nothing
    // new; its replacement (same id, a later epoch) is not drained.
    const current = release?.state === 'rolling' ? release.current : null;
    if (current?.worker_id === w.worker_id && (current.epoch === undefined || w.epoch <= current.epoch)) {
      return { task: null, reason: 'draining', retry_after: 30 };
    }

    const [{ quarantined }] = await tx<{ quarantined: boolean }[]>`
      SELECT COALESCE(quarantined_until > NOW(), FALSE) AS quarantined FROM fleet_slots WHERE account_no = ${w.account_no}`;
    if (!quarantined) {
      const [used] = await tx<{ minutes: number }[]>`SELECT ${minutesTodaySql(tx, w.account_no)} AS minutes`;
      if (used.minutes >= settings.budget_minutes) {
        return { task: null, retry_after: RETRY_BLOCKED, reason: 'budget' };
      }
    }
    // A quarantined account only probes its own slot; everyone else takes
    // searches and slug checks, plus a probe aimed at them whose quarantine
    // has lapsed meanwhile.
    const kinds = quarantined
      ? tx`t.kind = 'probe' AND t.account_no = ${w.account_no}`
      : tx`(t.kind <> 'probe' OR t.account_no = ${w.account_no})`;
    const [row] = await tx<PickRow[]>`
      ${taskRows(tx, w, settings)}
      WHERE t.state = 'ready' AND t.due_at <= NOW() AND ${kinds}
      ORDER BY t.priority DESC,
        (f.city IS NOT NULL) DESC,
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
    await tx`
      INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
      VALUES (${row.id}, ${w.worker_id}, 'handed', ${tx.json({ why: why(row) })})`;
    return { task: handed(row, leased.lease_expires_at) };
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
  if (!take || hold === 0) {
    const answer = await pickTask(sql, w, settings, done, take);
    return 'stale' in answer ? c.json({ error: 'stale_epoch' }, 409) : c.json(answer);
  }

  // Until the deadline, a wake that found nothing for this account (another
  // worker took the task, or it was a probe for someone else) holds again
  // instead of sending the worker away for retry_after.
  const deadline = Date.now() + hold * 1000;
  await waker(sql).ready;
  let wake = armWake(sql);
  try {
    let answer = await pickTask(sql, w, settings, done);
    for (;;) {
      if ('stale' in answer) return c.json({ error: 'stale_epoch' }, 409);
      const left = deadline - Date.now();
      if (answer.task || answer.reason !== 'nothing_due' || left <= 0 || holds >= MAX_HOLDS) return c.json(answer);
      holds++;
      try {
        await wake.wait(left);
      } finally {
        holds--;
      }
      wake.dispose();
      wake = armWake(sql);
      answer = await pickTask(sql, w, settings, null);
    }
  } finally {
    wake.dispose();
  }
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
  const accepted = await sql.begin(async (tx) => {
    if (!await eligibleSlot(tx, w, true)) return 'stale';
    const [task] = await tx<{ id: number; kind: string; city: string }[]>`
      SELECT id::int AS id, kind, city FROM fleet_tasks
      WHERE id = ${body.task_id as number} AND worker_id = ${w.worker_id} AND account_no = ${w.account_no} AND epoch = ${w.epoch} AND state = 'leased'`;
    if (!task) return 'missing';
    if (task.kind === 'verify-slug') await tx`SELECT slug FROM fleet_cities WHERE slug = ${task.city} FOR UPDATE`;
    const current = await tx`SELECT id FROM fleet_tasks WHERE id = ${task.id} AND worker_id = ${w.worker_id}
      AND account_no = ${w.account_no} AND epoch = ${w.epoch} AND state = 'leased' FOR UPDATE`;
    if (!current.length) return 'missing';
    await tx`INSERT INTO fleet_task_events (task_id, worker_id, kind, detail)
      VALUES (${task.id}, ${w.worker_id}, ${kind}, ${detail ? tx.json(detail as postgres.JSONValue) : null})`;
    if (kind === 'started') await tx`UPDATE fleet_tasks SET started_at = COALESCE(started_at, NOW()) WHERE id = ${task.id}`;
    // Only a finished check that saw the page is a verdict. A stopped one, or
    // one that hit an error or a wall (detail.error, detail.wall), says nothing about the slug and
    // leaves the city unverified, so the scheduler checks it again; marking
    // it verified would disable it for good over a slow proxy.
    if (task.kind === 'verify-slug' && kind === 'finished' && typeof detail?.matches === 'boolean'
      && detail.error == null && detail.wall == null) {
      const matches = detail.matches;
      const location = typeof detail.location === 'string' ? detail.location.slice(0, 200) : null;
      await tx`UPDATE fleet_cities SET verified_at = NOW(), verified_as = ${location}, enabled = ${matches}
        WHERE slug = ${task.city} AND disabled_at IS NULL
          AND (verified_at IS NULL OR (verified_as IS DISTINCT FROM 'override' AND verified_at <= (SELECT leased_at FROM fleet_tasks WHERE id = ${task.id})))`;
    }
    return 'ok';
  });
  if (accepted === 'stale') return c.json({ error: 'stale_epoch' }, 409);
  if (accepted === 'missing') return c.json(NOT_FOUND, 404);
  return c.json({ ok: true });
});

// ─── Session ──────────────────────────────────────────────────────────────────

worker.put('/session', workerAuth, async (c) => {
  const w: WorkerIdentity = c.var.worker;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const cookies = body ? parseCookies(body.cookies) : null;
  if (!cookies) return c.json({ ...BAD_REQUEST, detail: 'cookies' }, 422);
  const storageState = body!.storage_state === undefined ? undefined : parseStorageState(body!.storage_state);
  if (storageState === null || (storageState && JSON.stringify(storageState.cookies) !== JSON.stringify(cookies))) {
    return c.json({ ...BAD_REQUEST, detail: 'storage_state' }, 422);
  }
  if (body!.clear !== undefined && typeof body!.clear !== 'boolean') return c.json({ ...BAD_REQUEST, detail: 'clear' }, 422);
  const clear = body!.clear === true;
  // The stored session is what spares the next boot a login. An empty list,
  // or one without a Facebook session in it, replaces it only when the
  // worker says so outright.
  if (!clear && !cookies.some((k) => k.name === 'c_user')) return c.json({ ...BAD_REQUEST, detail: 'cookies: no c_user (send clear: true to empty the stored session)' }, 422);
  if (!clear && !cookies.some((k) => k.name === 'xs')) return c.json({ ...BAD_REQUEST, detail: 'cookies: no xs (send clear: true to empty the stored session)' }, 422);
  const token = body!.token;
  if (token !== undefined && token !== null && (typeof token !== 'string' || token.length > 4096)) {
    return c.json({ ...BAD_REQUEST, detail: 'token' }, 422);
  }
  const key = poolKey(c.env);
  if (!key) return c.json(unavailable('FB_POOL_KEY'), 503);
  const keep = clear ? [] : cookies;
  const uid = keep.length ? cookieUid(cookieTextFromList(keep)) : null;
  const sql = getDb(c.env);
  const updated = await sql.begin(async (tx): Promise<'stale' | 'foreign' | 'ok'> => {
    if (!await eligibleSlot(tx, w, true)) return 'stale';
    const [account] = await tx<{ uid: string | null; cookie_enc: string | null }[]>`
      SELECT uid, cookie_enc FROM fb_pool_accounts WHERE no = ${w.account_no}`;
    if (uid && account.uid && uid !== account.uid) return 'foreign';
    // A worker on the previous protocol must not erase the browser's saved databases.
    const previous = !clear && storageState === undefined
      ? storageStateFromText(unsealOrEmpty(account.cookie_enc, key)) : null;
    const origins = storageState?.origins ?? previous?.origins ?? [];
    const text = storageState || origins.length
      ? JSON.stringify({ cookies: keep, origins: clear ? [] : origins }) : cookieTextFromList(keep);
    // An absent token key keeps the stored token; null (or "") clears it.
    await tx`
      UPDATE fb_pool_accounts SET
        cookie_enc = ${keep.length ? seal(text, key) : null}, cookie_uid = ${uid},
        cookie_at = NOW(), cookie_by = ${w.worker_id}, updated_at = NOW(),
        token_enc = ${token === undefined ? tx`token_enc` : sealOrNull(token ?? '', key)}
      WHERE no = ${w.account_no}`;
    return 'ok';
  });
  if (updated === 'stale') return c.json({ error: 'stale_epoch' }, 409);
  if (updated === 'foreign') return c.json({ ...BAD_REQUEST, detail: 'cookies: c_user is not this account' }, 422);
  flog.info('fleet session resealed', { accountNo: w.account_no, workerId: w.worker_id, cookies: keep.length, cleared: clear, token: token !== undefined });
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
