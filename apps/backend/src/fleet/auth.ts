import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { every } from 'hono/combine';
import type { FleetWorkerTokenClaims } from '@recycle-erp/shared';
import { authMiddleware } from '../auth';
import { getDb, type SqlLike } from '../db';
import { requireManager } from '../lib/role';
import type { Env, User } from '../types';
import { loadHostByTokenHash, sha256hex, type ClaimTicketRow, type FleetHostRow, type FleetSlotRow } from './sql';

// ─── Fleet auth scopes ────────────────────────────────────────────────────────
// Four callers reach /api/fleet: a manager in the browser (session cookie), a
// host agent (a bearer whose sha256 is on its fleet_hosts row), a worker
// container before its claim (a single-use claim ticket the agent minted for
// it) and a worker after it (a bearer the ERP minted at claim time). The worker token is not a session: it
// names the slot's lease epoch, and a slot re-claimed elsewhere moves on to the
// next epoch, so the old worker's every call is refused with 409 and it exits.
// That is what keeps one Facebook account off two browsers at once.

export type ManagerEnv = { Bindings: Env; Variables: { user: User } };
export type HostEnv = { Bindings: Env; Variables: { host: FleetHostRow } };
export type WorkerEnv = { Bindings: Env; Variables: { worker: WorkerIdentity } };
/** The claim's caller: the host, and the ticket when a worker container claimed with one rather than the host token. */
export type ClaimEnv = { Bindings: Env; Variables: { host: FleetHostRow; ticket: ClaimTicketRow | null } };

/** The verified token plus the slot it names, as the row stands at this call.
 *  `rotated`: signed with the previous key, so the next heartbeat re-signs it. */
export type WorkerIdentity = FleetWorkerTokenClaims & { slot: FleetSlotRow; rotated: boolean };

export const WORKER_TOKEN_DAYS = 7;

const UNAUTHORIZED = { error: 'unauthorized' } as const;

/**
 * 503, not 401: the ERP lacks a key of its own. A worker reads 401 as "my
 * token is dead" and exits, and every exit is a Facebook login on restart, so
 * a missing variable during a deploy must not look like a refused token.
 */
export const unavailable = (variable: string) => ({ error: 'unavailable', detail: `${variable} is not set` } as const);

/** Session cookie plus the manager role, the way routes/coordinator.ts gates itself. */
export const managerOnly: MiddlewareHandler<ManagerEnv> = every(authMiddleware, requireManager);

function bearer(header: string | undefined): string | null {
  const m = header?.match(/^Bearer\s+(\S+)\s*$/);
  return m ? m[1] : null;
}

/**
 * The HMAC key behind worker tokens, or null when production has none: the
 * worker routes then answer 503 and say which variable is missing, while the
 * rest of the app boots as usual. Outside production the key is derived from
 * JWT_SECRET, as the pool's sealing key is, so dev and CI need no extra
 * variable.
 */
export function workerTokenKey(env: Env): Buffer | null {
  const raw = env.FLEET_WORKER_TOKEN_KEY?.trim();
  if (raw) return Buffer.from(raw, 'hex');
  if (env.NODE_ENV === 'production') return null;
  return Buffer.from(hkdfSync('sha256', env.JWT_SECRET, '', 'fleet-worker-token', 32));
}

/** The key a token signed before a rotation still verifies under, until the worker's next heartbeat re-signs it. */
export function previousWorkerTokenKey(env: Env): Buffer | null {
  const raw = env.FLEET_WORKER_TOKEN_KEY_PREVIOUS?.trim();
  return raw ? Buffer.from(raw, 'hex') : null;
}

const hmac = (key: Buffer, payload: string): Buffer => createHmac('sha256', key).update(payload).digest();

/** `base64url(json) . base64url(hmac)`; `exp` is Unix seconds. */
export function signWorkerToken(claims: FleetWorkerTokenClaims, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${hmac(key, payload).toString('base64url')}`;
}

export type TokenCheck =
  | { ok: true; claims: FleetWorkerTokenClaims; rotated: boolean }
  | { ok: false; reason: 'bad_token' | 'expired_token' };

/** Verifies under the current key, then the previous one; says why a token fails. */
export function checkWorkerToken(token: string, key: Buffer, previous: Buffer | null = null, now: Date = new Date()): TokenCheck {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'bad_token' };
  const [payload, sig] = parts;
  const given = Buffer.from(sig, 'base64url');
  const signedBy = (k: Buffer) => {
    const expected = hmac(k, payload);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  let rotated = false;
  if (!signedBy(key)) {
    if (!previous || !signedBy(previous)) return { ok: false, reason: 'bad_token' };
    rotated = true;
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_token' };
  }
  if (!claimsShaped(claims)) return { ok: false, reason: 'bad_token' };
  if (claims.exp * 1000 <= now.getTime()) return { ok: false, reason: 'expired_token' };
  return { ok: true, claims, rotated };
}

/** The claims of a token this key signed and that has not expired; null otherwise. */
export function verifyWorkerToken(token: string, key: Buffer, now: Date = new Date()): FleetWorkerTokenClaims | null {
  const r = checkWorkerToken(token, key, null, now);
  return r.ok ? r.claims : null;
}

function claimsShaped(v: unknown): v is FleetWorkerTokenClaims {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.worker_id === 'string' && c.worker_id.length > 0
    && Number.isInteger(c.account_no)
    && Number.isInteger(c.epoch)
    && typeof c.exp === 'number' && Number.isFinite(c.exp);
}

export const isMirror = (env: Env): boolean => env.FLEET_ROLE === 'mirror';

/**
 * FLEET_ROLE=mirror: the fleet runs on another ERP and this database holds a
 * copy of it. Managers may read; their writes would land on the copy and be
 * lost at the next sync, so they are refused. Any agent or worker that still
 * reaches this instance gets a 503, never a 401 or 409: those make a worker
 * exit, and every restart is a Facebook login.
 */
export const mirrorGate: MiddlewareHandler = async (c, next) => {
  if (!isMirror(c.env as Env)) return next();
  if (bearer(c.req.header('Authorization'))) {
    return c.json({ error: 'unavailable', detail: 'this ERP mirrors the fleet; it runs on another one' }, 503);
  }
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.json({ error: 'read_only', detail: 'this ERP mirrors the fleet; change it where the fleet runs' }, 409);
  }
  return next();
};

/**
 * A host agent's bearer. The stored hash is the lookup key, so a token never
 * sits in the database; a route with an `:id` must be the token's own host.
 */
export const hostAuth: MiddlewareHandler<HostEnv> = async (c, next) => {
  const token = bearer(c.req.header('Authorization'));
  if (!token) return c.json(UNAUTHORIZED, 401);
  const host = await loadHostByTokenHash(getDb(c.env), sha256hex(token));
  if (!host) return c.json(UNAUTHORIZED, 401);
  const id = c.req.param('id');
  if (id !== undefined && id !== host.host_id) return c.json(UNAUTHORIZED, 401);
  c.set('host', host);
  return next();
};

// ─── Claim tickets ────────────────────────────────────────────────────────────
// A worker container runs Chromium on Facebook; holding the host token, a
// compromised one could claim every free account on its host (passwords, TOTP
// seeds, cookies) and confirm its siblings stopped. A ticket can do one thing:
// the first claim for the worker id (and handoff epoch) it was minted for.

export const CLAIM_TICKET_PREFIX = 'fct_';
export const CLAIM_TICKET_MINUTES = 10;

/** A fresh ticket and the hash it is stored under. */
export function newClaimTicket(): { ticket: string; hash: string } {
  const ticket = CLAIM_TICKET_PREFIX + randomBytes(32).toString('base64url');
  return { ticket, hash: sha256hex(ticket) };
}

/**
 * `POST /worker/claim`: the host token (older agents and workers), or a
 * claim ticket. A ticket names its host, so the host's own checks still
 * apply; the claim itself checks its binding and spends it, under the
 * worker's lock. Host tokens are hex, so the prefix tells the two apart.
 */
export const claimAuth: MiddlewareHandler<ClaimEnv> = async (c, next) => {
  const token = bearer(c.req.header('Authorization'));
  if (!token) return c.json(UNAUTHORIZED, 401);
  const sql = getDb(c.env);
  if (!token.startsWith(CLAIM_TICKET_PREFIX)) {
    const host = await loadHostByTokenHash(sql, sha256hex(token));
    if (!host) return c.json(UNAUTHORIZED, 401);
    c.set('host', host);
    c.set('ticket', null);
    return next();
  }
  const [ticket] = await sql<ClaimTicketRow[]>`SELECT * FROM fleet_claim_tickets WHERE token_hash = ${sha256hex(token)}`;
  if (!ticket) return c.json({ ...UNAUTHORIZED, detail: 'bad_ticket' }, 401);
  if (ticket.expires_at.getTime() <= Date.now()) return c.json({ ...UNAUTHORIZED, detail: 'expired_ticket' }, 401);
  const [host] = await sql<FleetHostRow[]>`SELECT * FROM fleet_hosts WHERE host_id = ${ticket.host_id}`;
  if (!host) return c.json({ ...UNAUTHORIZED, detail: 'bad_ticket' }, 401);
  c.set('host', host);
  c.set('ticket', ticket);
  return next();
};

/**
 * A worker's bearer. A missing, bad or expired token is 401 (`detail` says
 * which); a good token whose epoch is no longer the slot's (or whose slot is
 * gone) is 409 stale_epoch on every route, which the worker reads as "exit,
 * let the agent claim again". A missing server key is 503, never 401.
 */
export const workerAuth: MiddlewareHandler<WorkerEnv> = async (c, next) => {
  const key = workerTokenKey(c.env);
  if (!key) return c.json(unavailable('FLEET_WORKER_TOKEN_KEY'), 503);
  const token = bearer(c.req.header('Authorization'));
  if (!token) return c.json({ ...UNAUTHORIZED, detail: 'missing_token' }, 401);
  const checked = checkWorkerToken(token, key, previousWorkerTokenKey(c.env));
  if (!checked.ok) return c.json({ ...UNAUTHORIZED, detail: checked.reason }, 401);
  const slot = await eligibleSlot(getDb(c.env), checked.claims);
  if (!slot) return c.json({ error: 'stale_epoch' }, 409);
  c.set('worker', { ...checked.claims, slot, rotated: checked.rotated });
  return next();
};

/** Pool edits lock the account first; worker writes use the same order. */
export async function eligibleSlot(sql: SqlLike, w: FleetWorkerTokenClaims, lock = false): Promise<FleetSlotRow | null> {
  const [account] = await sql<{ status: string; holder_name: string | null }[]>`
    SELECT status, holder_name FROM fb_pool_accounts WHERE no = ${w.account_no}
    ${lock ? sql`FOR NO KEY UPDATE` : sql``}`;
  if (!account || account.status !== 'fleet' || account.holder_name?.toLowerCase() !== w.worker_id.toLowerCase()) return null;
  const [slot] = await sql<FleetSlotRow[]>`SELECT * FROM fleet_slots WHERE account_no = ${w.account_no}
    ${lock ? sql`FOR UPDATE` : sql``}`;
  return slot && slot.epoch === w.epoch && slot.worker_id === w.worker_id ? slot : null;
}
