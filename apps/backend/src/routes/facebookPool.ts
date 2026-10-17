import { Hono } from 'hono';
import {
  FB_POOL_LIMIT,
  FB_POOL_SECRET_FIELDS,
  FB_POOL_STATUSES,
  FB_REPORT_REASONS,
  cookieUid,
  normalizeFbPoolDraft,
  validateFbPoolDraft,
  type FbPoolDraft,
  type FbPoolEventKind,
  type FbPoolStatus,
} from '@recycle-erp/shared';
import { authMiddleware } from '../auth';
import { getDb, type SqlLike } from '../db';
import { effectiveRole, requireManager } from '../lib/role';
import { poolKey, sealOrNull, unsealOrEmpty } from '../lib/sealed';
import type { Env, User } from '../types';

// ─── Facebook account pool ────────────────────────────────────────────────────
// Shared Marketplace logins. Purchasers take, return and report; managers add,
// import, edit, retire and remove. Every write returns the whole pool, which
// is dozens of rows, so the page replaces its snapshot instead of patching it.
// The fleet's own vault (trackers/facebook, worker logins) is a separate store:
// `fleet` here is a label saying which worker an account went to.

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
  note: string;
  status: FbPoolStatus;
  holder_user_id: string | null;
  holder_name: string | null;
  held_since: Date | null;
  added_at: Date;
  cookie_at: Date | null;
  batch: string;
};

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

async function writeEvent(
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
      note: r.note,
      status: r.status,
      holder: r.holder_name,
      holderId: r.holder_user_id,
      since: ms(r.held_since),
      addedAt: r.added_at.getTime(),
      cookieAt: ms(r.cookie_at),
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
};

function sealDraft(d: FbPoolDraft, key: Buffer): Sealed {
  return {
    password_enc: sealOrNull(d.password, key),
    totp_enc: sealOrNull(d.totp, key),
    email_password_enc: sealOrNull(d.emailPassword, key),
    cookie_enc: sealOrNull(d.cookie, key),
    cookie_uid: d.cookie ? cookieUid(d.cookie) : null,
  };
}

async function insertAccount(tx: Tx, d: FbPoolDraft, key: Buffer, batch: string, user: User): Promise<number> {
  const s = sealDraft(d, key);
  const holderId = await resolveHolder(tx, d.holder);
  const [row] = await tx<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (
      uid, password_enc, totp_enc, email, email_password_enc, recovery_email,
      cookie_enc, cookie_uid, note, status, holder_user_id, holder_name, held_since,
      cookie_at, batch, created_by
    ) VALUES (
      ${d.uid}, ${s.password_enc}, ${s.totp_enc}, ${d.email}, ${s.email_password_enc}, ${d.recovery},
      ${s.cookie_enc}, ${s.cookie_uid}, ${d.note}, ${d.status}, ${holderId}, ${d.holder},
      ${d.holder ? tx`NOW()` : null}, ${d.cookie ? tx`NOW()` : null}, ${batch}, ${user.id}
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
        cookie_at = ${cookieUnchanged ? cur.cookie_at : draft.cookie ? tx`NOW()` : null},
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
