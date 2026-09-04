// Internal transactions: a manager-written record that groups the bank rows of
// one internal money movement — a Mercury->PayPal transfer, a card-funding
// chain, a top-up that arrived split — and carries the note explaining it.
//
// It is not `pair_id`. A pair is two legs of ONE logical payment (same money
// seen twice, same sign) and collapses the feed row; a record holds N legs of
// SEVERAL real movements and has text. Filing a row here is a category verdict:
// it leaves the reconciliation queue, because it is not a seller payment.
//
// Manager-only, like the Payments page it belongs to, so the sub-app
// self-applies auth + the role gate (coordinator pattern).

import { Hono } from 'hono';
import { authMiddleware } from '../auth';
import { getDb } from '../db';
import { clampLimit, decodeCursor, encodeCursor, escapeLike } from '../lib/pagination';
import type { Env, User } from '../types';

const internalTx = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', async (c, next) => {
    if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
    return next();
  });

type SqlClient = ReturnType<typeof getDb>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Which legs of a record count toward its money. The Payments feed dedups a
// pair to its PayPal leg because a payment pair is one movement recorded twice
// — and both its legs carry the SAME sign. A transfer pair is the opposite:
// −5,000 out of Mercury and +5,000 into PayPal are two real movements, and
// dropping one would report the transfer as +5,000 instead of net zero. So the
// sign of the pair decides.
function countedFrag(sql: SqlClient, alias: string) {
  const a = sql(alias);
  return sql`
    CASE WHEN ${a}.pair_id IS NULL THEN TRUE
         WHEN (SELECT MIN(s.amount) * MAX(s.amount)
                 FROM bank_transactions s WHERE s.pair_id = ${a}.pair_id) > 0
           THEN ${a}.source = 'paypal'
         ELSE TRUE END`;
}

// The legs of the record, as logical payments: a pair renders as one row with
// both legs inside, exactly as the Payments feed serves them.
async function membersOf(sql: SqlClient, recordId: string) {
  const rows = await sql`
    SELECT bt.id, bt.source, bt.posted_at, bt.amount::float AS amount, bt.counterparty,
           bt.description, bt.paypal_txn_id, bt.pair_id, bt.external_id,
           (SELECT json_agg(json_build_object(
              'id', l.id, 'source', l.source, 'externalId', l.external_id,
              'postedAt', l.posted_at, 'amount', l.amount::float,
              'counterparty', l.counterparty, 'description', l.description,
              'paypalTxnId', l.paypal_txn_id) ORDER BY l.source DESC)
            FROM bank_transactions l
            WHERE bt.pair_id IS NOT NULL AND l.pair_id = bt.pair_id) AS pair_legs
    FROM bank_transactions bt
    WHERE bt.internal_txn_id = ${recordId}
      AND (bt.pair_id IS NULL OR bt.source = 'paypal')
    ORDER BY bt.posted_at DESC, bt.id DESC`;
  return rows.map((r) => ({
    id: r.id,
    source: r.pair_id ? 'paired' : r.source,
    postedAt: r.posted_at,
    amount: Number(r.amount),
    counterparty: r.counterparty,
    description: r.description,
    paypalTxnId: r.paypal_txn_id,
    legs: (r.pair_legs as unknown[] | null) ?? [{
      id: r.id, source: r.source, externalId: r.external_id, postedAt: r.posted_at,
      amount: Number(r.amount), counterparty: r.counterparty, description: r.description,
      paypalTxnId: r.paypal_txn_id,
    }],
  }));
}

// ─── List ─────────────────────────────────────────────────────────────────────

internalTx.get('/', async (c) => {
  const sql = getDb(c.env);
  const q = c.req.query('q')?.trim() ?? '';
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const cursor = decodeCursor(c.req.query('cursor'));

  const like = `%${escapeLike(q)}%`;
  const qFrag = q ? sql`(it.title ILIKE ${like} OR it.note ILIKE ${like})` : sql`TRUE`;
  const cursorFrag = cursor
    ? sql`AND (it.created_at, it.id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`
    : sql`AND TRUE`;
  const counted = countedFrag(sql, 'bt');

  const rows = await sql`
    SELECT it.id, it.title, it.note, it.created_at, u.name AS created_by_name,
           COALESCE(m.member_count, 0)::int AS member_count,
           COALESCE(m.total_in, 0)::float   AS total_in,
           COALESCE(m.total_out, 0)::float  AS total_out,
           COALESCE(m.net, 0)::float        AS net,
           m.first_posted_at, m.last_posted_at, m.sources
    FROM internal_transactions it
    LEFT JOIN users u ON u.id = it.created_by
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE bt.pair_id IS NULL OR bt.source = 'paypal') AS member_count,
             SUM(bt.amount) FILTER (WHERE ${counted} AND bt.amount > 0) AS total_in,
             SUM(bt.amount) FILTER (WHERE ${counted} AND bt.amount < 0) AS total_out,
             SUM(bt.amount) FILTER (WHERE ${counted})                   AS net,
             MIN(bt.posted_at) AS first_posted_at,
             MAX(bt.posted_at) AS last_posted_at,
             ARRAY_AGG(DISTINCT bt.source) AS sources
      FROM bank_transactions bt
      WHERE bt.internal_txn_id = it.id
    ) m ON TRUE
    WHERE ${qFrag} ${cursorFrag}
    ORDER BY it.created_at DESC, it.id DESC
    LIMIT ${limit + 1}`;

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeCursor({
        ts: (slice[slice.length - 1].created_at as Date).toISOString(),
        id: slice[slice.length - 1].id as string,
      })
    : null;

  return c.json({
    rows: slice.map((r) => ({
      id: r.id,
      title: r.title,
      note: r.note,
      createdAt: r.created_at,
      createdByName: r.created_by_name ?? null,
      memberCount: r.member_count,
      totalIn: Number(r.total_in),
      totalOut: Number(r.total_out),
      net: Number(r.net),
      firstPostedAt: r.first_posted_at,
      lastPostedAt: r.last_posted_at,
      sources: (r.sources as string[] | null) ?? [],
    })),
    nextCursor,
  });
});

// ─── Read one ────────────────────────────────────────────────────────────────

internalTx.get('/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404);

  const [record] = await sql`
    SELECT it.id, it.title, it.note, it.created_at, it.updated_at, u.name AS created_by_name
    FROM internal_transactions it
    LEFT JOIN users u ON u.id = it.created_by
    WHERE it.id = ${id}`;
  if (!record) return c.json({ error: 'Not found' }, 404);

  return c.json({
    id: record.id,
    title: record.title,
    note: record.note,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    createdByName: record.created_by_name ?? null,
    members: await membersOf(sql, id),
  });
});

// ─── Membership ──────────────────────────────────────────────────────────────
// Filing a row is a category verdict, so it writes category_manual: without it
// the next sync resets the category from what the provider said and the member
// reappears in the unlinked queue. Unlike mark-transfer it teaches no
// counterparty rule — that stays the explicit, page-level action.
//
// Every id expands to its whole leg group, the invariant the Payments routes
// are built on: the feed renders the PayPal leg alone, so a membership written
// to one leg of a pair would be invisible from the other.

async function addMembers(
  sql: SqlClient,
  recordId: string,
  txnIds: string[],
): Promise<{ error: string } | { added: number }> {
  const legs = await sql<{
    id: string; order_id: string | null; internal_txn_id: string | null; settle_status: string;
  }[]>`
    SELECT id, order_id, internal_txn_id, settle_status
    FROM bank_transactions
    WHERE id IN ${sql(txnIds)}
       OR pair_id IN (SELECT pair_id FROM bank_transactions
                      WHERE id IN ${sql(txnIds)} AND pair_id IS NOT NULL)`;
  if (legs.length === 0) return { error: 'Not found' };
  if (legs.some((l) => l.order_id)) {
    return { error: 'Unlink the transaction from its purchase order before filing it' };
  }
  // A record groups the legs of one real movement. A payment that never left,
  // or came back, has no leg to group.
  if (legs.some((l) => l.settle_status === 'failed' || l.settle_status === 'reversed')) {
    return { error: 'This payment did not settle' };
  }
  const other = legs.find((l) => l.internal_txn_id && l.internal_txn_id !== recordId);
  if (other) return { error: 'The transaction already belongs to another internal transaction' };

  const r = await sql`
    UPDATE bank_transactions
    SET internal_txn_id = ${recordId}, category = 'transfer', category_manual = TRUE
    WHERE id IN ${sql(legs.map((l) => l.id))}`;
  return { added: r.count };
}

function readIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids = raw.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v));
  return ids.length === raw.length ? ids : null;
}

internalTx.post('/', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{ title?: string; note?: string; txnIds?: unknown }>()
    .catch(() => ({} as { title?: string; note?: string; txnIds?: unknown }));
  const title = body.title?.trim() || null;
  const note = body.note?.trim() || null;
  const txnIds = body.txnIds === undefined ? [] : readIds(body.txnIds);
  if (txnIds === null) return c.json({ error: 'txnIds must be transaction ids' }, 400);

  let failure: string | null = null;
  let id = '';
  await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO internal_transactions (title, note, created_by)
      VALUES (${title}, ${note}, ${c.var.user.id})
      RETURNING id`;
    id = row.id;
    if (txnIds.length > 0) {
      const r = await addMembers(tx as unknown as SqlClient, id, txnIds);
      if ('error' in r) {
        failure = r.error;
        // The record and its members are one action: a refused member must not
        // leave an empty record behind.
        throw new Error('rollback');
      }
    }
  }).catch((e: unknown) => {
    if (!failure) throw e;
  });
  if (failure) return c.json({ error: failure }, 400);

  return c.json({ id }, 201);
});

internalTx.patch('/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json<{ title?: string | null; note?: string | null }>()
    .catch(() => ({} as { title?: string | null; note?: string | null }));

  const rows = await sql`
    UPDATE internal_transactions
    SET title = ${body.title === undefined ? sql`title` : (body.title?.trim() || null)},
        note  = ${body.note === undefined ? sql`note` : (body.note?.trim() || null)},
        updated_at = NOW()
    WHERE id = ${id}
    RETURNING id`;
  if (rows.length === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

internalTx.post('/:id/members', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404);
  const body = await c.req.json<{ txnIds?: unknown }>().catch(() => ({} as { txnIds?: unknown }));
  const txnIds = readIds(body.txnIds);
  if (!txnIds || txnIds.length === 0) return c.json({ error: 'txnIds is required' }, 400);

  const [record] = await sql`SELECT id FROM internal_transactions WHERE id = ${id}`;
  if (!record) return c.json({ error: 'Not found' }, 404);

  const r = await addMembers(sql, id, txnIds);
  if ('error' in r) return c.json({ error: r.error }, 400);
  return c.json({ ok: true, added: r.added });
});

// The category stays 'transfer': it was a human verdict, and silently returning
// the row to the unlinked queue would be the surprise. "Not a transfer" on the
// Payments page is the one click that undoes it.
internalTx.delete('/:id/members/:txnId', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const txnId = c.req.param('txnId');
  if (!UUID_RE.test(id) || !UUID_RE.test(txnId)) return c.json({ error: 'Not found' }, 404);

  const r = await sql`
    UPDATE bank_transactions SET internal_txn_id = NULL
    WHERE internal_txn_id = ${id}
      AND (id = ${txnId}
           OR pair_id = (SELECT pair_id FROM bank_transactions
                         WHERE id = ${txnId} AND pair_id IS NOT NULL))`;
  if (r.count === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

internalTx.delete('/:id', async (c) => {
  const sql = getDb(c.env);
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) return c.json({ error: 'Not found' }, 404);
  // Members are released by the FK's ON DELETE SET NULL.
  const r = await sql`DELETE FROM internal_transactions WHERE id = ${id}`;
  if (r.count === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true });
});

export default internalTx;
