// Bank-transaction reconciliation API (manager Payments page). Fully
// manager-only, so the sub-app self-applies auth + the role gate (coordinator
// pattern) and index.ts mounts it with a single app.route().
//
// The list serves LOGICAL payments: the PayPal charge and its Mercury
// settlement of one payment share pair_id, and the PayPal leg is the display
// row (it carries the counterparty detail). Every mutation writes all legs of
// the group atomically so the legs never disagree about link state.

import { Hono } from 'hono';
import { authMiddleware } from '../auth';
import { syncBankTransactions } from '../banktx/sync';
import { getDb } from '../db';
import { clampLimit, decodeCursor, encodeCursor } from '../lib/pagination';
import type { Env, User } from '../types';

const bankTx = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', async (c, next) => {
    if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
    return next();
  });

type SqlClient = ReturnType<typeof getDb>;

type LegRow = {
  id: string;
  source: string;
  external_id: string;
  posted_at: Date;
  amount: number;
  counterparty: string | null;
  description: string | null;
  paypal_txn_id: string | null;
  pair_id: string | null;
  order_id: string | null;
  link_kind: string | null;
  link_auto: boolean;
  linked_by: string | null;
  linked_at: Date | null;
  ignored: boolean;
  category: string;
};

function shapeLeg(l: LegRow) {
  return {
    id: l.id,
    source: l.source,
    externalId: l.external_id,
    postedAt: l.posted_at,
    amount: Number(l.amount),
    counterparty: l.counterparty,
    description: l.description,
    paypalTxnId: l.paypal_txn_id,
  };
}

// All legs of the logical payment `id` belongs to (1 row when unpaired).
async function groupOf(sql: SqlClient, id: string): Promise<LegRow[]> {
  return sql<LegRow[]>`
    SELECT id, source, external_id, posted_at, amount::float AS amount, counterparty,
           description, paypal_txn_id, pair_id, order_id, link_kind, link_auto,
           linked_by, linked_at, ignored, category
    FROM bank_transactions
    WHERE id = ${id}
       OR pair_id = (SELECT pair_id FROM bank_transactions WHERE id = ${id} AND pair_id IS NOT NULL)`;
}

// ─── List ─────────────────────────────────────────────────────────────────────

bankTx.get('/', async (c) => {
  const sql = getDb(c.env);
  const status = c.req.query('status') ?? 'all';
  const source = c.req.query('source') ?? 'all';
  const direction = c.req.query('direction') ?? 'all';
  const q = c.req.query('q')?.trim() ?? '';
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const cursor = decodeCursor(c.req.query('cursor'));

  const statusFrag =
    status === 'unlinked' ? sql`bt.order_id IS NULL AND NOT bt.ignored AND bt.category = 'external'`
    : status === 'linked' ? sql`bt.order_id IS NOT NULL`
    : status === 'ignored' ? sql`bt.ignored`
    : status === 'transfer' ? sql`bt.category = 'transfer'`
    : sql`TRUE`;
  // A paired payment involves both sources, so it matches either filter; the
  // display leg of a pair is always the PayPal one.
  const sourceFrag =
    source === 'mercury' ? sql`(bt.source = 'mercury' OR bt.pair_id IS NOT NULL)`
    : source === 'paypal' ? sql`bt.source = 'paypal'`
    : sql`TRUE`;
  const directionFrag =
    direction === 'out' ? sql`bt.amount < 0`
    : direction === 'in' ? sql`bt.amount > 0`
    : sql`TRUE`;
  const like = `%${q}%`;
  const qFrag = q
    ? sql`(bt.order_id ILIKE ${like} OR EXISTS (
        SELECT 1 FROM bank_transactions ql
        WHERE (ql.id = bt.id OR (bt.pair_id IS NOT NULL AND ql.pair_id = bt.pair_id))
          AND (ql.counterparty ILIKE ${like} OR ql.description ILIKE ${like}
               OR ql.paypal_txn_id ILIKE ${like} OR ql.external_id ILIKE ${like})))`
    : sql`TRUE`;
  const cursorFrag = cursor
    ? sql`AND (bt.posted_at, bt.id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`
    : sql`AND TRUE`;

  const rows = await sql`
    SELECT bt.id, bt.source, bt.external_id, bt.posted_at, bt.amount::float AS amount,
           bt.counterparty, bt.description, bt.paypal_txn_id, bt.pair_id,
           bt.order_id, bt.link_kind, bt.link_auto, bt.linked_at, bt.ignored, bt.category,
           u.name AS linked_by_name,
           (SELECT json_agg(json_build_object(
              'id', l.id, 'source', l.source, 'externalId', l.external_id,
              'postedAt', l.posted_at, 'amount', l.amount::float,
              'counterparty', l.counterparty, 'description', l.description,
              'paypalTxnId', l.paypal_txn_id) ORDER BY l.source DESC)
            FROM bank_transactions l
            WHERE bt.pair_id IS NOT NULL AND l.pair_id = bt.pair_id) AS pair_legs
    FROM bank_transactions bt
    LEFT JOIN users u ON u.id = bt.linked_by
    WHERE (bt.pair_id IS NULL OR bt.source = 'paypal')
      AND ${statusFrag} AND ${sourceFrag} AND ${directionFrag} AND ${qFrag} ${cursorFrag}
    ORDER BY bt.posted_at DESC, bt.id DESC
    LIMIT ${limit + 1}
  `;
  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore
    ? encodeCursor({
        ts: (slice[slice.length - 1].posted_at as Date).toISOString(),
        id: slice[slice.length - 1].id as string,
      })
    : null;

  return c.json({
    rows: slice.map((r) => ({
      id: r.id,
      source: r.pair_id ? 'paired' : r.source,
      postedAt: r.posted_at,
      amount: Number(r.amount),
      counterparty: r.counterparty,
      description: r.description,
      paypalTxnId: r.paypal_txn_id,
      legs: (r.pair_legs as ReturnType<typeof shapeLeg>[] | null) ?? [shapeLeg(r as unknown as LegRow)],
      orderId: r.order_id,
      linkKind: r.link_kind,
      linkAuto: r.link_auto,
      linkedAt: r.linked_at,
      linkedByName: r.linked_by_name ?? null,
      ignored: r.ignored,
      category: r.category,
    })),
    nextCursor,
  });
});

// ─── Stats (page tiles + sync freshness) ─────────────────────────────────────

bankTx.get('/stats', async (c) => {
  const sql = getDb(c.env);
  const [agg] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE order_id IS NULL AND NOT ignored AND category = 'external')::int AS unlinked_count,
      COALESCE(SUM(ABS(amount)) FILTER (WHERE order_id IS NULL AND NOT ignored AND category = 'external'), 0)::float AS unlinked_amount,
      COUNT(*) FILTER (WHERE category = 'transfer')::int                               AS transfer_count,
      COUNT(*) FILTER (WHERE order_id IS NOT NULL)::int                                AS linked_count,
      COUNT(*) FILTER (WHERE order_id IS NOT NULL AND link_kind = 'refund')::int       AS refund_count,
      COALESCE(SUM(amount) FILTER (WHERE order_id IS NOT NULL AND link_kind = 'refund'), 0)::float AS refund_amount,
      COUNT(*) FILTER (WHERE ignored)::int                                             AS ignored_count
    FROM bank_transactions
    WHERE pair_id IS NULL OR source = 'paypal'`;
  const sources = await sql`
    SELECT source, MAX(last_synced_at) AS last_synced_at FROM bank_accounts GROUP BY source`;
  return c.json({
    unlinked: { count: agg.unlinked_count, amount: agg.unlinked_amount },
    linked: { count: agg.linked_count },
    refunds: { count: agg.refund_count, amount: agg.refund_amount },
    ignored: { count: agg.ignored_count },
    transfers: { count: agg.transfer_count },
    sources: sources.map((s) => ({ source: s.source, lastSyncedAt: s.last_synced_at })),
  });
});

// ─── Sync now ────────────────────────────────────────────────────────────────

bankTx.post('/sync', async (c) => {
  const result = await syncBankTransactions(c.env);
  return c.json(result);
});

// ─── PO-side ledger ──────────────────────────────────────────────────────────
// Lives here (not routes/orders.ts) so the manager-only boundary stays in one
// place; the PO detail renders the section only for managers.

bankTx.get('/by-order/:orderId', async (c) => {
  const sql = getDb(c.env);
  const orderId = c.req.param('orderId');
  const rows = await sql<LegRow[]>`
    SELECT id, source, external_id, posted_at, amount::float AS amount, counterparty,
           description, paypal_txn_id, pair_id, order_id, link_kind, link_auto,
           linked_by, linked_at, ignored
    FROM bank_transactions
    WHERE order_id = ${orderId} AND (pair_id IS NULL OR source = 'paypal')
    ORDER BY posted_at DESC, id DESC`;
  const payments = rows.map((r) => ({
    ...shapeLeg(r),
    source: r.pair_id ? 'paired' : r.source,
    linkKind: r.link_kind,
    linkAuto: r.link_auto,
  }));
  const net = payments.reduce((sum, p) => sum + p.amount, 0);
  return c.json({ payments, net: Math.round(net * 100) / 100 });
});

// ─── Link / unlink ───────────────────────────────────────────────────────────

bankTx.post('/:id/link', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{ orderId?: string }>().catch(() => ({} as { orderId?: string }));
  const orderId = body.orderId?.trim();
  if (!orderId) return c.json({ error: 'orderId is required' }, 400);

  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  if (group[0].ignored) return c.json({ error: 'Unignore the transaction before linking it' }, 400);

  const order = await sql`SELECT id FROM orders WHERE id = ${orderId} LIMIT 1`;
  if (order.length === 0) return c.json({ error: 'Order not found' }, 404);

  const kind = group[0].amount < 0 ? 'payment' : 'refund';
  await sql`
    UPDATE bank_transactions
    SET order_id = ${orderId}, link_kind = ${kind}, link_auto = FALSE,
        linked_by = ${c.var.user.id}, linked_at = NOW()
    WHERE id IN ${sql(group.map((l) => l.id))}`;
  return c.json({ ok: true, orderId, linkKind: kind });
});

bankTx.post('/:id/unlink', async (c) => {
  const sql = getDb(c.env);
  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  if (!group[0].order_id) return c.json({ error: 'Not linked' }, 400);
  // The tombstone keeps auto-link from resurrecting the removed link on the
  // next sync; a manual re-link is unaffected.
  await sql`
    UPDATE bank_transactions
    SET order_id = NULL, link_kind = NULL, link_auto = FALSE,
        linked_by = NULL, linked_at = NULL, no_auto_link = TRUE
    WHERE id IN ${sql(group.map((l) => l.id))}`;
  return c.json({ ok: true });
});

// ─── Pair / unpair ───────────────────────────────────────────────────────────

bankTx.post('/:id/pair', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{ otherId?: string }>().catch(() => ({} as { otherId?: string }));
  if (!body.otherId) return c.json({ error: 'otherId is required' }, 400);

  const [a] = await groupOf(sql, c.req.param('id'));
  const [b] = await groupOf(sql, body.otherId);
  if (!a || !b) return c.json({ error: 'Not found' }, 404);
  if (a.pair_id || b.pair_id) return c.json({ error: 'Already paired' }, 400);
  if (a.source === b.source) return c.json({ error: 'A pair needs one Mercury and one PayPal leg' }, 400);
  if (Number(a.amount) !== Number(b.amount)) return c.json({ error: 'Amounts differ' }, 400);
  if (a.order_id && b.order_id && a.order_id !== b.order_id) {
    return c.json({ error: 'Legs are linked to different orders — unlink one first' }, 400);
  }

  const linked = a.order_id ? a : b.order_id ? b : null;
  await sql.begin(async (tx) => {
    const pairId = crypto.randomUUID();
    await tx`UPDATE bank_transactions SET pair_id = ${pairId} WHERE id IN (${a.id}, ${b.id})`;
    if (linked) {
      await tx`
        UPDATE bank_transactions
        SET order_id = ${linked.order_id}, link_kind = ${linked.link_kind},
            link_auto = ${linked.link_auto}, linked_by = ${linked.linked_by},
            linked_at = ${linked.linked_at}
        WHERE pair_id = ${pairId} AND order_id IS NULL`;
    }
  });
  return c.json({ ok: true });
});

bankTx.post('/:id/unpair', async (c) => {
  const sql = getDb(c.env);
  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  if (!group[0].pair_id) return c.json({ error: 'Not paired' }, 400);
  await sql`
    UPDATE bank_transactions
    SET pair_id = NULL, no_auto_pair = TRUE
    WHERE id IN ${sql(group.map((l) => l.id))}`;
  return c.json({ ok: true });
});

// ─── Ignore / unignore ───────────────────────────────────────────────────────

bankTx.post('/:id/ignore', async (c) => {
  const sql = getDb(c.env);
  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  if (group[0].order_id) return c.json({ error: 'Unlink the transaction before ignoring it' }, 400);
  await sql`
    UPDATE bank_transactions SET ignored = TRUE
    WHERE id IN ${sql(group.map((l) => l.id))}`;
  return c.json({ ok: true });
});

bankTx.post('/:id/unignore', async (c) => {
  const sql = getDb(c.env);
  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  await sql`
    UPDATE bank_transactions SET ignored = FALSE
    WHERE id IN ${sql(group.map((l) => l.id))}`;
  return c.json({ ok: true });
});

// ─── Mark / unmark transfer ──────────────────────────────────────────────────
// A human category verdict; category_manual keeps every future sync (and
// transfer-pairing) from overturning it.

bankTx.post('/:id/mark-transfer', async (c) => {
  const sql = getDb(c.env);
  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  if (group[0].order_id) return c.json({ error: 'Unlink the transaction before marking it a transfer' }, 400);
  await sql`
    UPDATE bank_transactions SET category = 'transfer', category_manual = TRUE
    WHERE id IN ${sql(group.map((l) => l.id))}`;
  return c.json({ ok: true });
});

bankTx.post('/:id/unmark-transfer', async (c) => {
  const sql = getDb(c.env);
  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  await sql`
    UPDATE bank_transactions SET category = 'external', category_manual = TRUE
    WHERE id IN ${sql(group.map((l) => l.id))}`;
  return c.json({ ok: true });
});

// ─── Link-picker suggestions ─────────────────────────────────────────────────
// Ranked candidates, computed at read time and never persisted: an exact
// PayPal-txn-id hit first (even when ambiguous — the human decides), then
// same-amount orders near the payment date, then free-text search.

bankTx.get('/:id/suggestions', async (c) => {
  const sql = getDb(c.env);
  const [leg] = await groupOf(sql, c.req.param('id'));
  if (!leg) return c.json({ error: 'Not found' }, 404);
  const q = c.req.query('q')?.trim() ?? '';

  type OrderRow = {
    id: string; total_cost: number | null; created_at: Date; lifecycle: string;
    created_by_name: string | null;
  };
  const shape = (r: OrderRow, reason: string) => ({
    id: r.id,
    totalCost: r.total_cost === null ? null : Number(r.total_cost),
    createdAt: r.created_at,
    lifecycle: r.lifecycle,
    createdByName: r.created_by_name,
    reason,
  });

  const seen = new Set<string>();
  const out: ReturnType<typeof shape>[] = [];
  const push = (rows: OrderRow[], reason: string) => {
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(shape(r, reason));
    }
  };

  if (leg.paypal_txn_id) {
    push(await sql<OrderRow[]>`
      SELECT o.id, o.total_cost::float AS total_cost, o.created_at, o.lifecycle, u.name AS created_by_name
      FROM orders o JOIN users u ON u.id = o.user_id
      WHERE UPPER(o.paypal_txn_id) = ${leg.paypal_txn_id}
      ORDER BY o.created_at DESC LIMIT 5`, 'txn');
  }
  if (!q) {
    push(await sql<OrderRow[]>`
      SELECT o.id, o.total_cost::float AS total_cost, o.created_at, o.lifecycle, u.name AS created_by_name
      FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.total_cost = ${Math.abs(Number(leg.amount))}
        AND o.created_at BETWEEN ${leg.posted_at}::timestamptz - INTERVAL '90 days'
                             AND ${leg.posted_at}::timestamptz + INTERVAL '90 days'
      ORDER BY o.created_at DESC LIMIT 10`, 'amount');
  } else {
    const like = `%${q}%`;
    push(await sql<OrderRow[]>`
      SELECT o.id, o.total_cost::float AS total_cost, o.created_at, o.lifecycle, u.name AS created_by_name
      FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.id ILIKE ${like} OR u.name ILIKE ${like}
      ORDER BY o.created_at DESC LIMIT 10`, 'search');
  }
  return c.json({ suggestions: out });
});

export default bankTx;
