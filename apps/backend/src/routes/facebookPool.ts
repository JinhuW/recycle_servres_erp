import { Hono } from 'hono';
import {
  FB_FAILED_OUTCOMES,
  FB_POOL_LIMIT,
  FB_POOL_SECRET_FIELDS,
  FB_POOL_STATUSES,
  FB_PROXY_DEAD_AFTER,
  FB_REPORT_REASONS,
  cookieUid,
  cookieValue,
  normalizeFbPoolDraft,
  totpKey,
  validateFbPoolDraft,
  type FbPoolDraft,
  type FbPoolEventKind,
  type FbAccountTimeline,
  type FbPoolStatus,
  type FbProxyMark,
  type FbStintOutcome,
  type FbTimelineEvent,
  type FbWorkerStint,
  type PoolAccountSummary,
} from '@recycle-erp/shared';
import { authMiddleware } from '../auth';
import { getDb, type SqlLike } from '../db';
import { allLimited } from '../lib/concurrency';
import { log } from '../lib/log';
import { effectiveRole, requireManager } from '../lib/role';
import { poolKey, sealOrNull, unsealOrEmpty } from '../lib/sealed';
import type { Env, User } from '../types';
import { ACCOUNT_ID, WORKER_ID, callFacade } from './coordinator';

// ─── Facebook account pool ────────────────────────────────────────────────────
// Shared Marketplace logins. Purchasers take, return and report; managers add,
// import, edit, retire and remove. Every write returns the whole pool, which
// is dozens of rows, so the page replaces its snapshot instead of patching it.
// The fleet's own vault (trackers/facebook, worker logins) is a separate store:
// `fleet` here says which worker an account went to, and `/assign` is the one
// route that copies a login across.

type Vars = { user: User; key: Buffer };
type Tx = SqlLike;

const NOT_CONFIGURED = 'The account pool is not configured — set FB_POOL_KEY';
const MAX_IMPORT_ROWS = 500;
const ACTIVITY_LIMIT = 100;
const HOLDER_STATUSES: readonly FbPoolStatus[] = ['taken', 'fleet', 'problem'];

type Row = {
  no: number;
  uid: string;
  password_enc: string | null;
  totp_enc: string | null;
  email: string;
  email_password_enc: string | null;
  recovery_email: string;
  cookie_enc: string | null;
  cookie_uid: string | null;
  token_enc: string | null;
  note: string;
  status: FbPoolStatus;
  holder_user_id: string | null;
  holder_name: string | null;
  held_since: Date | null;
  added_at: Date;
  cookie_at: Date | null;
  cookie_by: string | null;
  alive_checked_at: Date | null;
  batch: string;
};

type SummaryRow = Pick<
  Row,
  | 'no' | 'uid' | 'email' | 'note' | 'status' | 'holder_name' | 'holder_user_id' | 'held_since'
  | 'added_at' | 'cookie_at' | 'alive_checked_at' | 'batch' | 'cookie_uid'
> & { has_cookie: boolean };

type EventRow = {
  created_at: Date;
  actor_name: string;
  kind: FbPoolEventKind;
  account_no: number | null;
  detail: string | null;
  status: FbPoolStatus;
};

const ms = (d: Date | null) => (d === null ? null : d.getTime());

const pool = new Hono<{ Bindings: Env; Variables: Vars }>()
  .use('*', authMiddleware)
  .use('*', async (c, next) => {
    const key = poolKey(c.env);
    if (!key) return c.json({ error: NOT_CONFIGURED }, 503);
    c.set('key', key);
    return next();
  });

export async function writeEvent(
  tx: Tx,
  user: User,
  kind: FbPoolEventKind,
  status: FbPoolStatus,
  accountNo: number | null,
  detail: string | null,
): Promise<void> {
  await tx`
    INSERT INTO fb_pool_events (account_no, actor_id, actor_name, kind, status, detail)
    VALUES (${accountNo}, ${user.id}, ${user.name}, ${kind}, ${status}, ${detail})`;
}

/**
 * The page's view of the pool. A manager reads everything; a purchaser reads
 * the login of the accounts they hold and, for the rest, only what the rack
 * shows: status, holder, age, and the cookie's c_user so the UID check still
 * renders. A redacted cookie without a c_user keeps a placeholder so the page
 * says "No c_user" rather than "No cookie".
 */
async function snapshot(sql: SqlLike, key: Buffer, user: User) {
  const manager = effectiveRole(user) === 'manager';
  const rows = await sql<Row[]>`SELECT * FROM fb_pool_accounts ORDER BY no`;
  const accounts = rows.map((r) => {
    const full = manager || (r.holder_user_id === user.id && r.status === 'taken');
    let cookie = '';
    if (full) cookie = unsealOrEmpty(r.cookie_enc, key);
    else if (r.cookie_enc) cookie = r.cookie_uid ? `c_user=${r.cookie_uid}` : 'xs=redacted';
    return {
      no: r.no,
      uid: r.uid,
      password: full ? unsealOrEmpty(r.password_enc, key) : '',
      totp: full ? unsealOrEmpty(r.totp_enc, key) : '',
      email: r.email,
      emailPassword: full ? unsealOrEmpty(r.email_password_enc, key) : '',
      recovery: full ? r.recovery_email : '',
      cookie,
      token: full ? unsealOrEmpty(r.token_enc, key) : '',
      note: r.note,
      status: r.status,
      holder: r.holder_name,
      holderId: r.holder_user_id,
      since: ms(r.held_since),
      addedAt: r.added_at.getTime(),
      cookieAt: ms(r.cookie_at),
      cookieBy: r.cookie_by,
      aliveCheckedAt: ms(r.alive_checked_at),
      batch: r.batch,
    };
  });
  const activity = manager
    ? (
        await sql<EventRow[]>`
          SELECT created_at, actor_name, kind, account_no, detail, status
          FROM fb_pool_events ORDER BY created_at DESC LIMIT ${ACTIVITY_LIMIT}`
      ).map((e) => ({
        at: e.created_at.getTime(),
        who: e.actor_name,
        action: e.kind,
        accountNo: e.account_no ?? undefined,
        detail: e.detail ?? undefined,
        status: e.status,
      }))
    : [];
  return { accounts, activity };
}

function parseNo(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

function readDraft(input: unknown): FbPoolDraft | null {
  if (!input || typeof input !== 'object') return null;
  const b = input as Record<string, unknown>;
  const status = b.status;
  if (!FB_POOL_STATUSES.includes(status as FbPoolStatus)) return null;
  if (b.holder !== undefined && b.holder !== null && typeof b.holder !== 'string') return null;
  return normalizeFbPoolDraft({
    uid: str(b.uid),
    password: str(b.password),
    totp: str(b.totp),
    email: str(b.email),
    emailPassword: str(b.emailPassword),
    recovery: str(b.recovery),
    cookie: str(b.cookie),
    token: str(b.token),
    note: str(b.note),
    status: status as FbPoolStatus,
    holder: (b.holder as string | null | undefined) ?? null,
  });
}

/** The purchaser whose name the manager typed, when exactly one active member matches. */
async function resolveHolder(tx: Tx, holder: string | null): Promise<string | null> {
  if (!holder) return null;
  const rows = await tx<{ id: string }[]>`
    SELECT id FROM users WHERE lower(name) = lower(${holder}) AND COALESCE(active, TRUE)`;
  return rows.length === 1 ? rows[0].id : null;
}

async function existingUids(tx: Tx): Promise<Set<string>> {
  return new Set((await tx<{ uid: string }[]>`SELECT uid FROM fb_pool_accounts`).map((r) => r.uid));
}

function refusal(codes: string[]) {
  const code = codes.includes('fpDuplicate') ? 'fpDuplicate' : codes[0];
  return { status: codes.includes('fpDuplicate') ? 409 : 400, body: { error: 'Invalid account', code, codes } } as const;
}

// ── Every role: the rack, take, return, report, audit ───────────────────────

pool.get('/', async (c) => c.json(await snapshot(getDb(c.env), c.var.key, c.var.user)));

// Pages that only need who holds what (the fleet table, tab counts) poll this
// instead of the snapshot, which unseals every secret of every row per call.
// It answers every role alike: nothing in it is held back from a purchaser.
pool.get('/summary', async (c) => {
  const rows = await getDb(c.env)<SummaryRow[]>`
    SELECT no, uid, email, note, status, holder_name, holder_user_id, held_since, added_at,
           cookie_at, alive_checked_at, batch, cookie_enc IS NOT NULL AS has_cookie, cookie_uid
    FROM fb_pool_accounts ORDER BY no`;
  const accounts: PoolAccountSummary[] = rows.map((r) => ({
    no: r.no,
    uid: r.uid,
    email: r.email,
    note: r.note,
    status: r.status,
    holder: r.holder_name,
    holderId: r.holder_user_id,
    since: ms(r.held_since),
    addedAt: r.added_at.getTime(),
    cookieAt: ms(r.cookie_at),
    aliveCheckedAt: ms(r.alive_checked_at),
    batch: r.batch,
    hasCookie: r.has_cookie,
    cookieUid: r.has_cookie ? r.cookie_uid : null,
  }));
  return c.json({ accounts });
});

pool.post('/:no/take', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'Not found' }, 404);
  const sql = getDb(c.env);
  const user = c.var.user;
  const verdict = await sql.begin(async (tx) => {
    // One purchaser's takes run one at a time, so two clicks can't both pass
    // the limit check; the row lock then settles two purchasers on one tag.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'fb_pool:' + user.id}))`;
    const [row] = await tx<{ status: FbPoolStatus }[]>`
      SELECT status FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
    if (!row) return 'missing';
    if (row.status !== 'available') return 'unavailable';
    const [{ n }] = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM fb_pool_accounts
      WHERE holder_user_id = ${user.id} AND status = 'taken'`;
    if (n >= FB_POOL_LIMIT) return 'limit';
    await tx`
      UPDATE fb_pool_accounts
      SET status = 'taken', holder_user_id = ${user.id}, holder_name = ${user.name},
          held_since = NOW(), updated_at = NOW()
      WHERE no = ${no}`;
    await writeEvent(tx, user, 'took', 'taken', no, null);
    return 'ok';
  });
  if (verdict === 'missing') return c.json({ error: 'Not found' }, 404);
  if (verdict === 'unavailable') return c.json({ error: 'This account is no longer available', code: 'fpTakenElsewhere' }, 409);
  if (verdict === 'limit') return c.json({ error: `You already hold ${FB_POOL_LIMIT} accounts`, code: 'fpAtLimit' }, 409);
  return c.json(await snapshot(sql, c.var.key, user));
});

type HeldVerdict = 'missing' | 'forbidden' | 'not_taken' | 'ok';

/** Locks a taken account the caller may act on: its holder, or any manager. */
async function lockHeld(tx: Tx, no: number, user: User): Promise<HeldVerdict> {
  const [row] = await tx<{ status: FbPoolStatus; holder_user_id: string | null }[]>`
    SELECT status, holder_user_id FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
  if (!row) return 'missing';
  // Status first: the rack already shows everyone what is taken, so saying
  // "not taken" gives nothing away, and a stale tab gets the useful answer.
  if (row.status !== 'taken') return 'not_taken';
  if (row.holder_user_id !== user.id && user.role !== 'manager') return 'forbidden';
  return 'ok';
}

function heldRefusal(c: { json: (body: unknown, status: 403 | 404 | 409) => Response }, verdict: HeldVerdict) {
  if (verdict === 'missing') return c.json({ error: 'Not found' }, 404);
  if (verdict === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  return c.json({ error: 'This account is not taken', code: 'fpNotTaken' }, 409);
}

pool.post('/:no/return', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'Not found' }, 404);
  const sql = getDb(c.env);
  const user = c.var.user;
  const verdict = await sql.begin(async (tx) => {
    const v = await lockHeld(tx, no, user);
    if (v !== 'ok') return v;
    await tx`
      UPDATE fb_pool_accounts
      SET status = 'available', holder_user_id = NULL, holder_name = NULL,
          held_since = NULL, updated_at = NOW()
      WHERE no = ${no}`;
    await writeEvent(tx, user, 'returned', 'available', no, null);
    return v;
  });
  if (verdict !== 'ok') return heldRefusal(c, verdict);
  return c.json(await snapshot(sql, c.var.key, user));
});

pool.post('/:no/report', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'Not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { reason?: unknown; note?: unknown } | null;
  const reason = body?.reason;
  if (!FB_REPORT_REASONS.includes(reason as never)) return c.json({ error: 'Unknown reason' }, 400);
  const note = body?.note;
  if (note !== undefined && (typeof note !== 'string' || note.length > 2000))
    return c.json({ error: 'Invalid note' }, 400);
  const sql = getDb(c.env);
  const user = c.var.user;
  const verdict = await sql.begin(async (tx) => {
    const v = await lockHeld(tx, no, user);
    if (v !== 'ok') return v;
    // The holder stays on the row: it names who hit the problem.
    await tx`
      UPDATE fb_pool_accounts
      SET status = 'problem', note = COALESCE(${note ?? null}, note), updated_at = NOW()
      WHERE no = ${no}`;
    await writeEvent(tx, user, 'reported', 'problem', no, reason as string);
    return v;
  });
  if (verdict !== 'ok') return heldRefusal(c, verdict);
  return c.json(await snapshot(sql, c.var.key, user));
});

// A copy or reveal happens in the browser; the page reports it so the ledger
// says who looked at which login. Nothing on the row changes.
pool.post('/:no/events', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'Not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { kind?: unknown; field?: unknown } | null;
  const kind = body?.kind;
  if (kind !== 'copied' && kind !== 'revealed') return c.json({ error: 'Unknown kind' }, 400);
  if (!FB_POOL_SECRET_FIELDS.includes(body?.field as never)) return c.json({ error: 'Unknown field' }, 400);
  const sql = getDb(c.env);
  const user = c.var.user;
  const verdict = await sql.begin(async (tx) => {
    const [row] = await tx<{ status: FbPoolStatus; holder_user_id: string | null }[]>`
      SELECT status, holder_user_id FROM fb_pool_accounts WHERE no = ${no}`;
    if (!row) return 'missing';
    const mine = row.holder_user_id === user.id && row.status === 'taken';
    if (!mine && user.role !== 'manager') return 'forbidden';
    await writeEvent(tx, user, kind, row.status, no, body?.field as string);
    return 'ok';
  });
  if (verdict === 'missing') return c.json({ error: 'Not found' }, 404);
  if (verdict === 'forbidden') return c.json({ error: 'Forbidden' }, 403);
  return c.json({ ok: true });
});

// ── Managers: add, import, edit, retire, remove ─────────────────────────────

pool.use('*', requireManager);

type Sealed = {
  password_enc: string | null;
  totp_enc: string | null;
  email_password_enc: string | null;
  cookie_enc: string | null;
  cookie_uid: string | null;
  token_enc: string | null;
};

function sealDraft(d: FbPoolDraft, key: Buffer): Sealed {
  return {
    password_enc: sealOrNull(d.password, key),
    totp_enc: sealOrNull(d.totp, key),
    email_password_enc: sealOrNull(d.emailPassword, key),
    cookie_enc: sealOrNull(d.cookie, key),
    cookie_uid: d.cookie ? cookieUid(d.cookie) : null,
    token_enc: sealOrNull(d.token, key),
  };
}

async function insertAccount(tx: Tx, d: FbPoolDraft, key: Buffer, batch: string, user: User): Promise<number> {
  const s = sealDraft(d, key);
  const holderId = await resolveHolder(tx, d.holder);
  const [row] = await tx<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (
      uid, password_enc, totp_enc, email, email_password_enc, recovery_email,
      cookie_enc, cookie_uid, token_enc, note, status, holder_user_id, holder_name, held_since,
      cookie_at, cookie_by, batch, created_by
    ) VALUES (
      ${d.uid}, ${s.password_enc}, ${s.totp_enc}, ${d.email}, ${s.email_password_enc}, ${d.recovery},
      ${s.cookie_enc}, ${s.cookie_uid}, ${s.token_enc}, ${d.note}, ${d.status}, ${holderId}, ${d.holder},
      ${d.holder ? tx`NOW()` : null}, ${d.cookie ? tx`NOW()` : null}, ${d.cookie ? user.name : null}, ${batch}, ${user.id}
    ) RETURNING no`;
  return row.no;
}

const readBatch = (v: unknown, fallback: string) => {
  const b = str(v).trim().slice(0, 120);
  return b || fallback;
};

pool.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { draft?: unknown; batch?: unknown } | null;
  const draft = readDraft(body?.draft);
  if (!draft) return c.json({ error: 'Invalid account' }, 400);
  const sql = getDb(c.env);
  const user = c.var.user;
  const result = await sql.begin(async (tx) => {
    const codes = validateFbPoolDraft(draft, await existingUids(tx));
    if (codes.length) return refusal(codes);
    const no = await insertAccount(tx, draft, c.var.key, readBatch(body?.batch, 'Manual'), user);
    await writeEvent(tx, user, 'added', draft.status, no, null);
    return null;
  });
  if (result) return c.json(result.body, result.status);
  return c.json(await snapshot(sql, c.var.key, user), 201);
});

pool.put('/:no', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'Not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { draft?: unknown } | null;
  const draft = readDraft(body?.draft);
  if (!draft) return c.json({ error: 'Invalid account' }, 400);
  // A bundle built before the token field sends none; that keeps the stored
  // token instead of erasing it. An empty string still clears it.
  const tokenSent = typeof (body?.draft as Record<string, unknown>).token === 'string';
  const sql = getDb(c.env);
  const user = c.var.user;
  const key = c.var.key;
  const result = await sql.begin(async (tx) => {
    const [cur] = await tx<Row[]>`SELECT * FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
    if (!cur) return { status: 404, body: { error: 'Not found' } } as const;
    const codes = validateFbPoolDraft(draft, await existingUids(tx), cur.uid);
    if (codes.length) return refusal(codes);
    const s = sealDraft(draft, key);
    // A cookie that reads the same keeps its age; a new one is fresh today.
    const cookieUnchanged = draft.cookie === unsealOrEmpty(cur.cookie_enc, key);
    const sameHolder =
      !!draft.holder && !!cur.holder_name && draft.holder.toLowerCase() === cur.holder_name.toLowerCase();
    const holderId = sameHolder ? cur.holder_user_id : await resolveHolder(tx, draft.holder);
    await tx`
      UPDATE fb_pool_accounts SET
        uid = ${draft.uid}, password_enc = ${s.password_enc}, totp_enc = ${s.totp_enc},
        email = ${draft.email}, email_password_enc = ${s.email_password_enc},
        recovery_email = ${draft.recovery}, cookie_enc = ${s.cookie_enc}, cookie_uid = ${s.cookie_uid},
        token_enc = ${tokenSent ? s.token_enc : cur.token_enc},
        cookie_at = ${cookieUnchanged ? cur.cookie_at : draft.cookie ? tx`NOW()` : null},
        cookie_by = ${cookieUnchanged ? cur.cookie_by : draft.cookie ? user.name : null},
        note = ${draft.note}, status = ${draft.status},
        holder_user_id = ${holderId}, holder_name = ${draft.holder},
        held_since = ${draft.holder ? (sameHolder && cur.held_since ? cur.held_since : tx`NOW()`) : null},
        updated_at = NOW()
      WHERE no = ${no}`;
    await writeEvent(tx, user, 'edited', draft.status, no, null);
    return null;
  });
  if (result) return c.json(result.body, result.status);
  return c.json(await snapshot(sql, key, user));
});

// Sends an account's login to a fleet worker, server to server; the answer is
// the pool, which a manager already reads. Cookie-first: when the account has
// a cookie that is its own (its c_user matches), that cookie is sealed as the
// worker's session and the worker restores it — logged in with no password and
// no 2FA, which is the gentlest way onto a new IP. Only when there is no usable
// cookie is the vault's password login queued instead; a worker restoring a
// cookie falls back to it on its own if the session does not take.
// A worker that already holds another account keeps it unless the caller says
// where it goes (`previous`); there is no default, because "it broke" and
// "we're rotating" end in different places.
// The device the login was made in, without the login: the pool cookie's
// datr/sb, which the worker presents so its first sign-in is the account's own
// machine on a new IP rather than a stranger's. Only for a cookie of this very
// account. The session cookies (c_user, xs, fr) never ride the account write;
// the whole session travels only on the cookie-first path, sealed as the
// slot's own snapshot through the coordinator's session route.
const DEVICE_COOKIE_DAYS = 400;
function legacyDevice(cookie: string, cookieUidValue: string | null, uid: string) {
  if (!cookie || cookieUidValue !== uid) return {};
  const expires = Math.floor(Date.now() / 1000) + DEVICE_COOKIE_DAYS * 86_400;
  const device_cookies = (['datr', 'sb'] as const)
    .map((name) => [name, cookieValue(cookie, name)] as const)
    .filter((entry): entry is readonly [typeof entry[0], string] => entry[1] !== null)
    .map(([name, value]) => ({
      name, value, domain: '.facebook.com', path: '/', expires,
      httpOnly: true, secure: true, sameSite: 'None' as const,
    }));
  return device_cookies.length ? { device_cookies } : {};
}

// The proxy a worker browses through now, as the fleet document names it
// (scheme://host:port, login cut out; null on the VM's own IP). A worker the
// document doesn't list, a facade that predates the exit lookup, or a document
// that can't be read leaves it unknown, and an unknown proxy is not recorded.
type WorkerProxy = { url: string | null; known: boolean };
type FleetDocProxies = { workers?: { worker_id?: unknown; proxy?: { url?: unknown } | null }[] } | null;

async function workerProxy(env: Env, worker: string): Promise<WorkerProxy> {
  const fleet = await callFacade(env, 'GET', '/v1/fleet');
  if (fleet.error) {
    log.warn('fleet document unreadable; the proxy is left unknown', { module: 'facebookPool', workerId: worker, error: fleet.error });
    return { url: null, known: false };
  }
  const w = (fleet.payload as FleetDocProxies)?.workers
    ?.find((x) => typeof x.worker_id === 'string' && x.worker_id.toLowerCase() === worker.toLowerCase());
  if (!w?.proxy) return { url: null, known: false };
  return { url: typeof w.proxy.url === 'string' ? w.proxy.url : null, known: true };
}

// An unknown proxy is checked as the one the worker's last account went
// through: proxies change far less often than accounts do.
async function lastProxy(sql: SqlLike, worker: string): Promise<string | null> {
  const [row] = await sql<{ proxy_url: string | null }[]>`
    SELECT proxy_url FROM fb_worker_accounts
    WHERE lower(worker_id) = lower(${worker}) AND proxy_known
    ORDER BY started_at DESC LIMIT 1`;
  return row?.proxy_url ?? null;
}

type MarkRow = { url: string; failed: number; dead_at: Date | null; revived_at: Date | null; revived_by_name: string | null };

/**
 * Each proxy's distinct failed accounts since its last revive. The account
 * that takes it past FB_PROXY_DEAD_AFTER makes it DEAD, at the moment its
 * stint ended. A proxy with no failures since its revive is left out.
 */
async function proxyMarks(sql: SqlLike, url?: string): Promise<FbProxyMark[]> {
  const rows = await sql<MarkRow[]>`
    WITH failed AS (
      SELECT w.proxy_url AS url, w.account_no, MIN(w.ended_at) AS failed_at
      FROM fb_worker_accounts w
      LEFT JOIN fb_proxies p ON p.url = w.proxy_url
      WHERE w.proxy_url IS NOT NULL
        AND w.outcome = ANY(${FB_FAILED_OUTCOMES as string[]}::text[])
        AND w.ended_at > COALESCE(p.revived_at, '-infinity'::timestamptz)
        ${url === undefined ? sql`` : sql`AND w.proxy_url = ${url}`}
      GROUP BY w.proxy_url, w.account_no
    ), ranked AS (
      SELECT url, failed_at, ROW_NUMBER() OVER (PARTITION BY url ORDER BY failed_at) AS n FROM failed
    )
    SELECT r.url, COUNT(*)::int AS failed,
           MAX(r.failed_at) FILTER (WHERE r.n = ${FB_PROXY_DEAD_AFTER + 1}) AS dead_at,
           MAX(p.revived_at) AS revived_at, MAX(p.revived_by_name) AS revived_by_name
    FROM ranked r LEFT JOIN fb_proxies p ON p.url = r.url
    GROUP BY r.url ORDER BY r.url`;
  return rows.map((r) => ({
    url: r.url,
    failed: r.failed,
    dead: r.failed > FB_PROXY_DEAD_AFTER,
    deadAt: ms(r.dead_at),
    revivedAt: ms(r.revived_at),
    revivedBy: r.revived_by_name,
  }));
}

const PREVIOUS_FATES = ['available', 'problem', 'retired'] as const;
type PreviousFate = (typeof PREVIOUS_FATES)[number];
const PREVIOUS_EVENT: Record<PreviousFate, FbPoolEventKind> = {
  available: 'returned',
  problem: 'reported',
  retired: 'retired',
};

pool.post('/:no/assign', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'Not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as
    { worker?: unknown; account?: unknown; previous?: unknown } | null;
  const worker = body?.worker;
  if (typeof worker !== 'string' || !WORKER_ID.test(worker)) return c.json({ error: 'Not a valid worker id' }, 400);
  // The vault account the worker already signs in with, else one named after it.
  const account = body?.account ?? worker;
  if (typeof account !== 'string' || !ACCOUNT_ID.test(account)) return c.json({ error: 'Not a valid account id' }, 400);
  const previous = body?.previous ?? null;
  if (previous !== null && !PREVIOUS_FATES.includes(previous as PreviousFate))
    return c.json({ error: 'Unknown previous status' }, 400);

  const sql = getDb(c.env);
  const user = c.var.user;
  const key = c.var.key;
  const [row] = await sql<Row[]>`SELECT * FROM fb_pool_accounts WHERE no = ${no}`;
  if (!row) return c.json({ error: 'Not found' }, 404);
  if (row.status === 'retired') return c.json({ error: 'This account is retired', code: 'fpAssignRetired' }, 409);
  // The fleet dialog picks from a snapshot; a purchaser or another worker may
  // have taken the account since, and two workers on one login is the
  // location churn that gets it revoked.
  if (row.status === 'taken' || (row.status === 'fleet' && row.holder_name?.toLowerCase() !== worker.toLowerCase()))
    return c.json({ error: `#${no} is held by ${row.holder_name ?? 'someone else'}`, code: 'fpAssignHeld' }, 409);
  const held = await sql<{ no: number }[]>`
    SELECT no FROM fb_pool_accounts
    WHERE status = 'fleet' AND lower(holder_name) = lower(${worker}) AND no <> ${no}`;
  if (held.length && previous === null)
    return c.json({ error: `#${held[0].no} is already on ${worker}`, code: 'fpWorkerTaken' }, 409);
  const password = unsealOrEmpty(row.password_enc, key);
  if (!password) return c.json({ error: 'This account has no password to sign in with', code: 'fpNoPassword' }, 409);
  // Read before anything reaches the worker: an account sent through a proxy
  // that has burned more than FB_PROXY_DEAD_AFTER is the next one it burns.
  const proxy = await workerProxy(c.env, worker);
  const checked = proxy.known ? proxy.url : await lastProxy(sql, worker);
  if (checked) {
    const [mark] = await proxyMarks(sql, checked);
    if (mark?.dead)
      return c.json({ error: `${worker}'s proxy ${checked} is DEAD: ${mark.failed} accounts failed on it`, code: 'fpProxyDead' }, 409);
  }
  const cookie = unsealOrEmpty(row.cookie_enc, key);
  // Cookie-first: a cookie that is this account's own (its c_user matches) can
  // be restored as the worker's session — logged in with no password login,
  // which replayed from the worker's IP is what gets accounts checkpointed. The
  // password stays in the vault as the worker's own fallback if it does not take.
  const cookieFirst = Boolean(cookie) && cookieUid(cookie) === row.uid;

  // Every secret is set, empty ones cleared: what the worker held before
  // belongs to the previous account. The uid travels with the login because
  // it picks the browser identity the worker presents; a worker left with the
  // previous login's uid would sign the new account in from that one's device.
  const orNull = (v: string) => v || null;
  const write = await callFacade(c.env, 'PUT', `/v1/accounts/${encodeURIComponent(account)}`, {
    worker_id: worker,
    fb_username: row.email || row.uid,
    fb_uid: row.uid,
    allow_password_login: true,
    secrets: {
      password,
      totp_secret: orNull(totpKey(unsealOrEmpty(row.totp_enc, key))),
      email: orNull(row.email),
      email_password: orNull(unsealOrEmpty(row.email_password_enc, key)),
      // The access token lets the worker mint a fresh session when its cookie
      // lapses — a softer signal than a password login — so it travels even in
      // password mode, as the worker's own refresh before the password.
      fb_token: orNull(unsealOrEmpty(row.token_enc, key)),
    },
    ...legacyDevice(cookie, row.cookie_uid, row.uid),
  });
  if (write.error) return c.json({ error: write.error }, write.status);

  let mode: 'cookie' | 'password' = cookieFirst ? 'cookie' : 'password';
  if (cookieFirst) {
    // Seal the cookie as the slot's session, then have the worker restore it:
    // no password, no 2FA. The worker falls back to a password login on its
    // own if the restored session does not take.
    const seed = await callFacade(c.env, 'PUT', `/v1/workers/${encodeURIComponent(worker)}/session`, { cookie, reason: `assign #${no}` });
    if (seed.error) {
      // A 4xx is the fleet saying no to this cookie, not failing: a console
      // older than the session route answers 404, and a cookie copied without
      // its httpOnly xs is a 422. The vault already holds the new login, so a
      // password login finishes the Assign; a 5xx may pass, so it is retried.
      if (seed.status >= 500) return c.json({ error: `The login reached ${worker}, but its session was not seeded: ${seed.error}` }, seed.status);
      mode = 'password';
    } else {
      const restore = await callFacade(c.env, 'POST', `/v1/workers/${encodeURIComponent(worker)}/restore-session`);
      if (restore.error) return c.json({ error: `The session was seeded on ${worker}, but the restore was not queued: ${restore.error}` }, restore.status);
    }
  }
  if (mode === 'password') {
    const relogin = await callFacade(c.env, 'POST', `/v1/workers/${encodeURIComponent(worker)}/relogin`);
    if (relogin.error) return c.json({ error: `The login reached ${worker}, but Re-login was not queued: ${relogin.error}` }, relogin.status);
  }
  log.info('fleet worker given a pool login', { module: 'facebookPool', accountNo: no, workerId: worker, mode, by: user.email });

  await sql.begin(async (tx) => {
    await tx`
      UPDATE fb_pool_accounts SET
        status = 'fleet', holder_user_id = NULL, holder_name = ${worker},
        held_since = CASE WHEN status = 'fleet' AND lower(holder_name) = lower(${worker})
                          THEN held_since ELSE NOW() END,
        updated_at = NOW()
      WHERE no = ${no}`;
    await writeEvent(tx, user, 'assigned', 'fleet', no, worker);
    // The trigger opened the stint (or kept the one already running); the
    // proxy is the one thing it can't know.
    if (proxy.known) {
      await tx`
        UPDATE fb_worker_accounts SET proxy_url = ${proxy.url}, proxy_known = TRUE
        WHERE account_no = ${no} AND ended_at IS NULL`;
    }
    if (previous === null) return;
    const fate = previous as PreviousFate;
    // Whatever is on this worker now moves, not only what was read before the
    // vault write: an account put on it meanwhile would otherwise stay fleet.
    // A problem account keeps the worker as holder, naming where it failed.
    const moved = await tx<{ no: number }[]>`
      UPDATE fb_pool_accounts SET
        status = ${fate}, holder_user_id = NULL,
        holder_name = ${fate === 'problem' ? tx`holder_name` : null},
        held_since = ${fate === 'problem' ? tx`held_since` : null},
        updated_at = NOW()
      WHERE no <> ${no} AND status = 'fleet' AND lower(holder_name) = lower(${worker})
      RETURNING no`;
    for (const m of moved) {
      await writeEvent(tx, user, PREVIOUS_EVENT[fate], fate, m.no, `replaced by #${no} on ${worker}`);
    }
  });
  return c.json(await snapshot(sql, key, user));
});

// ── Proxies and each worker's accounts ──────────────────────────────────────

pool.get('/proxies', async (c) => c.json({ proxies: await proxyMarks(getDb(c.env)) }));

// After the IP behind a proxy is swapped, or the failures turn out to be the
// accounts' own fault: its count starts again from now.
pool.post('/proxies/revive', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
  const url = body?.url;
  if (typeof url !== 'string' || !url || url.length > 500) return c.json({ error: 'Not a proxy url' }, 400);
  const sql = getDb(c.env);
  const user = c.var.user;
  await sql`
    INSERT INTO fb_proxies (url, revived_at, revived_by, revived_by_name)
    VALUES (${url}, NOW(), ${user.id}, ${user.name})
    ON CONFLICT (url) DO UPDATE SET
      revived_at = NOW(), revived_by = EXCLUDED.revived_by, revived_by_name = EXCLUDED.revived_by_name`;
  log.info('fleet proxy revived', { module: 'facebookPool', proxyUrl: url, by: user.email });
  return c.json({ proxies: await proxyMarks(sql) });
});

type StintRow = {
  account_no: number;
  uid: string;
  email: string | null;
  proxy_url: string | null;
  proxy_known: boolean;
  started_at: Date;
  ended_at: Date | null;
  outcome: FbStintOutcome | null;
};

pool.get('/workers/:worker/accounts', async (c) => {
  const worker = c.req.param('worker');
  if (!WORKER_ID.test(worker)) return c.json({ error: 'Not a valid worker id' }, 400);
  const rows = await getDb(c.env)<StintRow[]>`
    SELECT w.account_no, w.uid, a.email, w.proxy_url, w.proxy_known, w.started_at, w.ended_at, w.outcome
    FROM fb_worker_accounts w LEFT JOIN fb_pool_accounts a ON a.no = w.account_no
    WHERE lower(w.worker_id) = lower(${worker})
    ORDER BY w.started_at DESC, w.id DESC`;
  const stints: FbWorkerStint[] = rows.map((r) => ({
    accountNo: r.account_no,
    uid: r.uid,
    email: r.email || null,
    proxyUrl: r.proxy_url,
    proxyKnown: r.proxy_known,
    startedAt: r.started_at.getTime(),
    endedAt: ms(r.ended_at),
    outcome: r.outcome,
  }));
  return c.json({ stints });
});

// One account's life on the fleet, newest first: the pool's own ledger, and
// every login the workers it was on attempted for it. The coordinator's ledger
// names the account (`uid:<uid>`) only on newer rows; an older row is this
// account's when it started on a worker while the account was on it.
type LedgerRow = {
  worker_id: string;
  identity_key: string | null;
  trigger: string | null;
  outcome: string | null;
  started_at: string;
  detail: { kind?: unknown; url?: unknown } | null;
};
const LEDGER_ROWS = 500;
const TIMELINE_POOL_EVENTS = 500;

pool.get('/:no/timeline', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'Not found' }, 404);
  const sql = getDb(c.env);
  const [[account], stints, ledger] = await allLimited([
    () => sql<{ uid: string; added_at: Date; batch: string }[]>`
      SELECT uid, added_at, batch FROM fb_pool_accounts WHERE no = ${no}`,
    () => sql<{ worker_id: string; uid: string; started_at: Date; ended_at: Date | null }[]>`
      SELECT worker_id, uid, started_at, ended_at FROM fb_worker_accounts WHERE account_no = ${no}`,
    () => sql<EventRow[]>`
      SELECT created_at, actor_name, kind, account_no, detail, status FROM fb_pool_events
      WHERE account_no = ${no} AND kind NOT IN ('added', 'copied', 'revealed', 'edited')
      ORDER BY created_at DESC LIMIT ${TIMELINE_POOL_EVENTS}`,
  ] as const);
  const uid = account?.uid ?? stints[0]?.uid;
  if (!uid) return c.json({ error: 'Not found' }, 404);

  const events: FbTimelineEvent[] = ledger.map((e) => ({
    kind: 'pool', at: e.created_at.getTime(), action: e.kind, status: e.status, detail: e.detail, by: e.actor_name,
  }));
  if (account) events.push({ kind: 'added', at: account.added_at.getTime(), batch: account.batch });

  // When the account first went on each worker. A holder that isn't a worker
  // id has no ledger to read.
  const firstOn = new Map<string, { worker: string; at: number }>();
  for (const s of stints) {
    if (!WORKER_ID.test(s.worker_id)) continue;
    const k = s.worker_id.toLowerCase();
    const at = s.started_at.getTime();
    if (!firstOn.has(k) || at < firstOn.get(k)!.at) firstOn.set(k, { worker: s.worker_id, at });
  }
  const workers = [...firstOn.values()];
  const reads = await allLimited(workers.map((w) => () =>
    callFacade(c.env, 'GET', `/v1/logins?worker_id=${encodeURIComponent(w.worker)}&limit=${LEDGER_ROWS}`)));
  // A full page whose oldest row is newer than the account's first stint there
  // has cut off that stint's early logins.
  const cut = reads.some((r, i) => {
    const rows = (r.payload as { logins?: LedgerRow[] } | null)?.logins ?? [];
    return !r.error && rows.length >= LEDGER_ROWS
      && Math.min(...rows.map((row) => Date.parse(row.started_at))) > workers[i].at;
  });
  const failed = reads.filter((r) => r.error).length;
  let logins: FbAccountTimeline['logins'] = 'ok';
  if (reads.some((r) => r.status === 404)) logins = 'not_served';
  else if (failed && failed === reads.length) logins = 'unreachable';
  else if (failed || cut) logins = 'partial';
  const key = `uid:${uid}`;
  const onIt = (worker: string, at: number) => stints.some((s) =>
    s.worker_id.toLowerCase() === worker.toLowerCase()
    && at >= s.started_at.getTime() && (s.ended_at === null || at <= s.ended_at.getTime()));
  for (const read of reads) {
    if (read.error) continue;
    for (const row of ((read.payload as { logins?: LedgerRow[] } | null)?.logins ?? [])) {
      const at = Date.parse(row.started_at);
      if (row.identity_key ? row.identity_key !== key : !onIt(row.worker_id, at)) continue;
      const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
      events.push({
        kind: 'login', at, worker: row.worker_id, trigger: row.trigger, outcome: row.outcome,
        detail: str(row.detail?.kind), url: str(row.detail?.url),
      });
    }
  }
  events.sort((a, b) => b.at - a.at);
  const body: FbAccountTimeline = { events, logins };
  return c.json(body);
});

pool.post('/:no/retire', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'Not found' }, 404);
  const sql = getDb(c.env);
  const user = c.var.user;
  const found = await sql.begin(async (tx) => {
    const rows = await tx`
      UPDATE fb_pool_accounts
      SET status = 'retired', holder_user_id = NULL, holder_name = NULL, held_since = NULL, updated_at = NOW()
      WHERE no = ${no} RETURNING no`;
    if (!rows.length) return false;
    await writeEvent(tx, user, 'retired', 'retired', no, null);
    return true;
  });
  if (!found) return c.json({ error: 'Not found' }, 404);
  return c.json(await snapshot(sql, c.var.key, user));
});

pool.delete('/:no', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'Not found' }, 404);
  const sql = getDb(c.env);
  const user = c.var.user;
  const found = await sql.begin(async (tx) => {
    const rows = await tx<{ uid: string }[]>`DELETE FROM fb_pool_accounts WHERE no = ${no} RETURNING uid`;
    if (!rows.length) return false;
    await writeEvent(tx, user, 'removed', 'retired', no, rows[0].uid);
    return true;
  });
  if (!found) return c.json({ error: 'Not found' }, 404);
  return c.json(await snapshot(sql, c.var.key, user));
});

// All-or-nothing: the page already dropped the rows that fail its own checks,
// so a refusal here means the pool changed under it (another import landed
// the same uid). The offending rows are named so it can show which.
pool.post('/import', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { batch?: unknown; rows?: unknown } | null;
  if (!Array.isArray(body?.rows) || body.rows.length === 0) return c.json({ error: 'No rows' }, 400);
  if (body.rows.length > MAX_IMPORT_ROWS) return c.json({ error: `At most ${MAX_IMPORT_ROWS} rows per import` }, 400);
  const drafts = body.rows.map(readDraft);
  if (drafts.some((d) => d === null)) return c.json({ error: 'Invalid account' }, 400);
  const batch = readBatch(body.batch, 'Imported');
  const sql = getDb(c.env);
  const user = c.var.user;
  const result = await sql.begin(async (tx) => {
    const taken = await existingUids(tx);
    const failures: { index: number; uid: string; codes: string[] }[] = [];
    (drafts as FbPoolDraft[]).forEach((d, index) => {
      const codes = validateFbPoolDraft(d, taken);
      if (taken.has(d.uid)) codes.includes('fpDuplicate') || codes.push('fpDuplicate');
      if (codes.length) failures.push({ index, uid: d.uid, codes });
      taken.add(d.uid);
    });
    if (failures.length) {
      const dup = failures.every((f) => f.codes.every((code) => code === 'fpDuplicate'));
      return { status: dup ? 409 : 400, body: { error: 'Some rows were refused', code: dup ? 'fpDuplicate' : undefined, failures } } as const;
    }
    for (const d of drafts as FbPoolDraft[]) await insertAccount(tx, d, c.var.key, batch, user);
    await writeEvent(tx, user, 'imported', 'available', null, `${drafts.length} · ${batch}`);
    return null;
  });
  if (result) return c.json(result.body, result.status);
  return c.json(await snapshot(sql, c.var.key, user), 201);
});

export default pool;
