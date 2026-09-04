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
import {
  fetchCandidates, hasMatchFrag, matchSummaries, openRowFrag, pairCandidatesBatch,
  PAIR_AUTO_WINDOW_DAYS, PAIR_PICK_WINDOW_DAYS,
  type MatchLeg, type PairCandidate, type PairLeg,
} from '../banktx/match';
import { syncBankTransactions } from '../banktx/sync';
import { getDb } from '../db';
import { writeOrderEvent } from '../services/orderAudit';
import { clampLimit, decodeCursor, encodeCursor, escapeLike } from '../lib/pagination';
import type { Env, User } from '../types';

const bankTx = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', async (c, next) => {
    if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
    return next();
  });

type SqlClient = ReturnType<typeof getDb>;

// A bad ?assignee= reaches Postgres as a ::uuid cast, which errors as a 500
// rather than the 400 the caller earned.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SETTLE_FILTERS = ['all', 'settled', 'pending', 'failed', 'reversed'];
// Money that never moved, or moved and came back. Nothing may be linked,
// paired, assigned or filed against it — there is no payment to reconcile.
// The SQL half of this rule lives in openRowFrag (banktx/match.ts).
const SETTLE_DEAD = ['failed', 'reversed'];
const isDead = (r: { settle_status?: unknown }) => SETTLE_DEAD.includes(r.settle_status as string);

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
  settle_status: string;
  internal_txn_id: string | null;
  assignee_id: string | null;
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
    settleStatus: l.settle_status,
  };
}

// The one-click grouping suggestion, or nothing. Certainty has to hold on both
// sides — exactly one counterpart for this leg, and this leg the only one for
// that counterpart. Eligibility is symmetric, so a reverse count of 1 can only
// be this leg. Anything less certain belongs in the picker, not on a button.
function soleCandidate(list: PairCandidate[] | undefined) {
  if (!list || list.length !== 1 || list[0].reverseCount !== 1) return null;
  const { reverseCount: _ignored, orderId: _unused, externalId: _unread, ...shown } = list[0];
  return shown;
}

// All legs of the logical payment `id` belongs to (1 row when unpaired).
async function groupOf(sql: SqlClient, id: string): Promise<LegRow[]> {
  return sql<LegRow[]>`
    SELECT id, source, external_id, posted_at, amount::float AS amount, counterparty,
           description, paypal_txn_id, pair_id, order_id, link_kind, link_auto,
           linked_by, linked_at, ignored, category, settle_status, internal_txn_id, assignee_id
    FROM bank_transactions
    WHERE id = ${id}
       OR pair_id = (SELECT pair_id FROM bank_transactions WHERE id = ${id} AND pair_id IS NOT NULL)
    ORDER BY source DESC, id`;
}

// ─── List ─────────────────────────────────────────────────────────────────────

bankTx.get('/', async (c) => {
  const sql = getDb(c.env);
  const status = c.req.query('status') ?? 'all';
  const source = c.req.query('source') ?? 'all';
  const direction = c.req.query('direction') ?? 'all';
  const q = c.req.query('q')?.trim() ?? '';
  const assignee = c.req.query('assignee')?.trim() ?? '';
  if (assignee && assignee !== 'unassigned' && !UUID_RE.test(assignee)) {
    return c.json({ error: 'assignee must be a user id or "unassigned"' }, 400);
  }
  const hasMatch = c.req.query('hasMatch') === '1';
  const dispute = c.req.query('dispute') === '1';
  const settle = c.req.query('settle') ?? 'all';
  if (!SETTLE_FILTERS.includes(settle)) {
    return c.json({ error: `settle must be one of ${SETTLE_FILTERS.join(', ')}` }, 400);
  }
  const limit = clampLimit(c.req.query('limit'), 50, 200);
  const cursor = decodeCursor(c.req.query('cursor'));

  const statusFrag =
    status === 'unlinked' ? openRowFrag(sql, 'bt')
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
  const like = `%${escapeLike(q)}%`;
  const qFrag = q
    ? sql`(bt.order_id ILIKE ${like} OR EXISTS (
        SELECT 1 FROM bank_transactions ql
        WHERE (ql.id = bt.id OR (bt.pair_id IS NOT NULL AND ql.pair_id = bt.pair_id))
          AND (ql.counterparty ILIKE ${like} OR ql.description ILIKE ${like}
               OR ql.paypal_txn_id ILIKE ${like} OR ql.external_id ILIKE ${like})))`
    : sql`TRUE`;
  // The owner lives on every leg, so the display leg alone answers this.
  const assigneeFrag =
    assignee === '' ? sql`TRUE`
    : assignee === 'unassigned' ? sql`bt.assignee_id IS NULL`
    : sql`bt.assignee_id = ${assignee}::uuid`;
  const cursorFrag = cursor
    ? sql`AND (bt.posted_at, bt.id) < (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`
    : sql`AND TRUE`;
  // In the WHERE rather than applied to the page, so keyset pagination over
  // the filtered set doesn't return short pages.
  const matchFrag = hasMatch
    ? sql`${openRowFrag(sql, 'bt')} AND ${hasMatchFrag(sql, 'bt')}`
    : sql`TRUE`;
  // Money out, because that is what "the case we submitted" means: we paid a
  // seller and want it back. PayPal has no field saying who filed a case, but a
  // transaction's sign is its direction here, and a case filed *against* us
  // would sit on an incoming payment. Consequence worth knowing: if the app
  // ever gains seller scope, those cases are stored and stay invisible.
  const disputeFrag = dispute ? sql`bt.dispute IS NOT NULL AND bt.amount < 0` : sql`TRUE`;
  // In the WHERE for the same reason as `hasMatch` above — a lens applied to
  // the page would return short pages under keyset paging.
  const settleFrag = settle === 'all' ? sql`TRUE` : sql`bt.settle_status = ${settle}`;

  // `order_cost` is what the bank was asked to pay for the linked PO, so a row
  // can be read against its own amount: goods (a line mirror or a negotiated lot
  // price) plus the fees charged on top. Goods alone reads short of the payment
  // on any PO carrying a fee, which is most of them — `amountDateFrag` in
  // banktx/match.ts matches on both for that reason. NULL when there is no
  // stored goods total, since a fees-only figure would read as the PO's cost.
  //
  // The join is aliased `po`, not `o`: `hasMatchFrag` lands in this WHERE
  // carrying its own `EXISTS (SELECT 1 FROM orders o …)`.
  const rows = await sql`
    SELECT bt.id, bt.source, bt.external_id, bt.posted_at, bt.amount::float AS amount,
           bt.counterparty, bt.description, bt.paypal_txn_id, bt.pair_id,
           bt.order_id, bt.link_kind, bt.link_auto, bt.linked_at, bt.ignored, bt.category,
           bt.settle_status,
           u.name AS linked_by_name,
           (po.total_cost + po.other_fees)::float AS order_cost,
           -- Money-out only, matching the tile and the ?dispute=1 filter below.
           -- fetchDisputes takes every case on the account, so a chargeback
           -- filed *against* us lands on an incoming payment: ungated, that row
           -- badged red in the default list while the Disputed tile read 0 and
           -- clicking it returned nothing. A transaction's sign is the only
           -- filer PayPal gives us.
           CASE WHEN bt.amount < 0 THEN bt.dispute END AS dispute,
           bt.internal_txn_id, it.title AS internal_txn_title,
           bt.assignee_id, au.name AS assignee_name, au.initials AS assignee_initials,
           (SELECT json_agg(json_build_object(
              'id', l.id, 'source', l.source, 'externalId', l.external_id,
              'postedAt', l.posted_at, 'amount', l.amount::float,
              'counterparty', l.counterparty, 'description', l.description,
              'paypalTxnId', l.paypal_txn_id,
              'settleStatus', l.settle_status) ORDER BY l.source DESC)
            FROM bank_transactions l
            WHERE bt.pair_id IS NOT NULL AND l.pair_id = bt.pair_id) AS pair_legs
    FROM bank_transactions bt
    LEFT JOIN users u ON u.id = bt.linked_by
    LEFT JOIN orders po ON po.id = bt.order_id
    LEFT JOIN users au ON au.id = bt.assignee_id
    LEFT JOIN internal_transactions it ON it.id = bt.internal_txn_id
    WHERE (bt.pair_id IS NULL OR bt.source = 'paypal')
      AND ${statusFrag} AND ${sourceFrag} AND ${directionFrag} AND ${qFrag}
      AND ${assigneeFrag} AND ${matchFrag} AND ${disputeFrag} AND ${settleFrag} ${cursorFrag}
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

  // Only the rows the manager can still act on need candidates; a linked,
  // ignored or transfer row is already off the queue.
  const openLegs: MatchLeg[] = slice
    .filter((r) => !r.order_id && !r.ignored && r.category === 'external' && !isDead(r))
    .map((r) => ({
      id: r.id as string,
      amount: Number(r.amount),
      posted_at: r.posted_at as Date,
      counterparty: (r.counterparty as string | null) ?? null,
      paypal_txn_id: (r.paypal_txn_id as string | null) ?? null,
    }));
  const matches = await matchSummaries(sql, openLegs);

  // Grouping candidates for the rows that can still be grouped — unpaired, and
  // open, because only an open row renders the suggestion. limit 2 is all the
  // decision needs: one is a suggestion, two is ambiguity the picker handles.
  const pairLegs: PairLeg[] = slice
    // Settled only: an unsettled leg is not half of a payment yet, which is
    // the rule autoPair and pairEligibleFrag both follow.
    .filter((r) => !r.pair_id && !r.order_id && !r.ignored && r.category === 'external'
      && r.settle_status === 'settled')
    .map((r) => ({
      id: r.id as string,
      source: r.source as string,
      amount: Number(r.amount),
      posted_at: r.posted_at as Date,
      order_id: null,
    }));
  const pairs = await pairCandidatesBatch(sql, pairLegs, {
    windowDays: PAIR_AUTO_WINDOW_DAYS,
    limit: 2,
    skipTombstoned: true,
  });

  return c.json({
    rows: slice.map((r) => ({
      id: r.id,
      match: matches.get(r.id as string) ?? null,
      pairCandidate: soleCandidate(pairs.get(r.id as string)),
      source: r.pair_id ? 'paired' : r.source,
      postedAt: r.posted_at,
      amount: Number(r.amount),
      counterparty: r.counterparty,
      description: r.description,
      paypalTxnId: r.paypal_txn_id,
      legs: (r.pair_legs as ReturnType<typeof shapeLeg>[] | null) ?? [shapeLeg(r as unknown as LegRow)],
      orderId: r.order_id,
      orderCost: r.order_cost,
      linkKind: r.link_kind,
      linkAuto: r.link_auto,
      linkedAt: r.linked_at,
      linkedByName: r.linked_by_name ?? null,
      ignored: r.ignored,
      category: r.category,
      settleStatus: r.settle_status,
      // The whole case, timeline included: it is a few entries on a handful of
      // rows, so a second round trip when someone expands the row would be
      // machinery for nothing.
      disputes: r.dispute ?? null,
      internalTxn: r.internal_txn_id
        ? { id: r.internal_txn_id, title: r.internal_txn_title ?? null }
        : null,
      assignee: r.assignee_id
        ? { id: r.assignee_id, name: r.assignee_name, initials: r.assignee_initials }
        : null,
    })),
    nextCursor,
  });
});

// ─── Stats (page tiles + sync freshness) ─────────────────────────────────────

bankTx.get('/stats', async (c) => {
  const sql = getDb(c.env);
  // The two tiles the queue actually filters on take the same direction lens the
  // list does. The page defaults to money OUT, so a direction-blind unlinked
  // count reported rows the list below it was hiding — and once the money-out
  // queue was drained the page said "nothing left to reconcile" while unlinked
  // incoming payments sat there unseen. Linked / refunds / ignored / transfers
  // stay direction-blind: those are not what the queue filters on.
  const direction = c.req.query('direction') ?? 'all';
  const dirFragBt =
    direction === 'out' ? sql`AND bt.amount < 0`
    : direction === 'in' ? sql`AND bt.amount > 0`
    : sql``;
  // `openRowFrag` rather than an inline copy of it: the Unlinked tile and the
  // ?status=unlinked list have to answer the same question, and when this held
  // its own copy the two drifted the moment either grew a condition.
  const open = openRowFrag(sql, 'bt');
  const [agg] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE ${open} ${dirFragBt})::int AS unlinked_count,
      COALESCE(SUM(ABS(bt.amount)) FILTER (WHERE ${open} ${dirFragBt}), 0)::float AS unlinked_amount,
      COUNT(*) FILTER (WHERE bt.category = 'transfer')::int                            AS transfer_count,
      COUNT(*) FILTER (WHERE bt.order_id IS NOT NULL)::int                             AS linked_count,
      COUNT(*) FILTER (WHERE bt.order_id IS NOT NULL AND bt.link_kind = 'refund')::int  AS refund_count,
      COALESCE(SUM(bt.amount) FILTER (WHERE bt.order_id IS NOT NULL AND bt.link_kind = 'refund'), 0)::float AS refund_amount,
      COUNT(*) FILTER (WHERE bt.ignored)::int                                          AS ignored_count,
      -- Money-out is baked into the predicate, not left to the direction lens:
      -- an incoming disputed payment is a case against us, not one we filed,
      -- and the tile has to agree with the list.
      COUNT(*) FILTER (WHERE bt.dispute IS NOT NULL AND bt.amount < 0)::int             AS dispute_count,
      COALESCE(SUM(ABS(bt.amount)) FILTER (WHERE bt.dispute IS NOT NULL AND bt.amount < 0), 0)::float AS dispute_amount
    FROM bank_transactions bt
    WHERE bt.pair_id IS NULL OR bt.source = 'paypal'`;
  const [suggested] = await sql`
    SELECT COUNT(*)::int AS count
    FROM bank_transactions bt
    WHERE (bt.pair_id IS NULL OR bt.source = 'paypal')
      AND ${openRowFrag(sql, 'bt')}
      AND ${hasMatchFrag(sql, 'bt')}
      ${dirFragBt}`;
  const sources = await sql`
    SELECT source, MAX(last_synced_at) AS last_synced_at,
           MAX(dispute_error) AS dispute_error
    FROM bank_accounts GROUP BY source`;
  return c.json({
    unlinked: { count: agg.unlinked_count, amount: agg.unlinked_amount },
    suggested: { count: suggested.count },
    linked: { count: agg.linked_count },
    refunds: { count: agg.refund_count, amount: agg.refund_amount },
    ignored: { count: agg.ignored_count },
    transfers: { count: agg.transfer_count },
    disputes: { count: agg.dispute_count, amount: agg.dispute_amount },
    sources: sources.map((s) => ({
      source: s.source,
      lastSyncedAt: s.last_synced_at,
      // Disputes are a separate PayPal permission, so this can be set while the
      // transaction sync is perfectly healthy. The page says so rather than
      // showing an empty dispute list that reads as "no cases".
      disputeError: s.dispute_error ?? null,
    })),
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
           linked_by, linked_at, ignored, settle_status, internal_txn_id, assignee_id
    FROM bank_transactions
    WHERE order_id = ${orderId} AND (pair_id IS NULL OR source = 'paypal')
    ORDER BY posted_at DESC, id DESC`;
  const payments = rows.map((r) => ({
    ...shapeLeg(r),
    source: r.pair_id ? 'paired' : r.source,
    linkKind: r.link_kind,
    linkAuto: r.link_auto,
  }));
  // A payment can be reversed after it was linked — PayPal reuses the
  // transaction id — so the row stays on the PO, listed and badged, but the
  // money it represents is no longer part of what the PO has been paid.
  const net = payments.reduce(
    (sum, p) => (SETTLE_DEAD.includes(p.settleStatus) ? sum : sum + p.amount), 0);
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
  if (group.some((l) => l.ignored)) return c.json({ error: 'Unignore the transaction before linking it' }, 400);
  // The money never left, or came back. Linking it would make the PO read as
  // paid by a payment that did not happen.
  if (group.some(isDead)) return c.json({ error: 'This payment did not settle' }, 400);
  // A membership is part of a record someone wrote a note on, so it is refused
  // rather than cleared. The owner tag below has no such home and goes quietly.
  if (group.some((l) => l.internal_txn_id)) {
    return c.json({ error: 'Remove the transaction from its internal transaction before linking it' }, 400);
  }

  const order = await sql`SELECT id FROM orders WHERE id = ${orderId} LIMIT 1`;
  if (order.length === 0) return c.json({ error: 'Order not found' }, 404);

  const kind = group[0].amount < 0 ? 'payment' : 'refund';
  const txnId = group.find((l) => l.paypal_txn_id)?.paypal_txn_id ?? null;
  const orderTxnFilled = await sql.begin(async (tx) => {
    await tx`
      UPDATE bank_transactions
      SET order_id = ${orderId}, link_kind = ${kind}, link_auto = FALSE,
          linked_by = ${c.var.user.id}, linked_at = NOW(),
          assignee_id = NULL, assigned_by = NULL, assigned_at = NULL
      WHERE id IN ${tx(group.map((l) => l.id))}`;
    if (!txnId) return false;
    // Only into an empty field: a PO already naming a transaction was told so
    // by the purchaser who paid, and a manager linking here is not a
    // correction of that. The link stands either way.
    const filled = await tx`
      UPDATE orders SET paypal_txn_id = ${txnId}
      WHERE id = ${orderId} AND paypal_txn_id IS NULL
      RETURNING id`;
    if (filled.length === 0) return false;
    await writeOrderEvent(tx, orderId, c.var.user.id, 'meta_changed', {
      changes: [{ field: 'paypal_txn_id', from: null, to: txnId }],
    });
    return true;
  });
  return c.json({ ok: true, orderId, linkKind: kind, orderTxnFilled });
});

bankTx.post('/:id/unlink', async (c) => {
  const sql = getDb(c.env);
  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  if (!group.some((l) => l.order_id)) return c.json({ error: 'Not linked' }, 400);
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

// ─── Pair-picker candidates ──────────────────────────────────────────────────
// The manual counterpart to autoPair: the legs this one may be grouped with,
// on the rules POST /:id/pair enforces. Two deliberate differences from the
// automatic matcher — a wider window, because a human is reading the list
// rather than a job acting unattended, and no tombstone filter, because
// no_auto_pair gates "auto" only (see migrations/0100) and a human regrouping
// on purpose should not be blocked by their own earlier Ungroup.

bankTx.get('/:id/pair-candidates', async (c) => {
  const sql = getDb(c.env);
  const [leg] = await groupOf(sql, c.req.param('id'));
  if (!leg) return c.json({ error: 'Not found' }, 404);
  if (leg.pair_id) return c.json({ candidates: [] });

  const found = await pairCandidatesBatch(
    sql,
    [{
      id: leg.id,
      source: leg.source,
      amount: Number(leg.amount),
      posted_at: leg.posted_at,
      order_id: leg.order_id,
    }],
    { windowDays: PAIR_PICK_WINDOW_DAYS, limit: 20, skipTombstoned: false },
  );
  return c.json({ candidates: found.get(leg.id) ?? [] });
});

bankTx.post('/:id/pair', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{ otherId?: string }>().catch(() => ({} as { otherId?: string }));
  if (!body.otherId) return c.json({ error: 'otherId is required' }, 400);

  const [a] = await groupOf(sql, c.req.param('id'));
  const [b] = await groupOf(sql, body.otherId);
  if (!a || !b) return c.json({ error: 'Not found' }, 404);
  if (a.pair_id || b.pair_id) return c.json({ error: 'Already paired' }, 400);
  if (a.source === b.source) return c.json({ error: 'A pair needs one Mercury and one PayPal leg' }, 400);
  // Settled on both sides: a pending charge's settlement leg has not happened
  // yet, so whatever it is being grouped with is not it. Same rule autoPair
  // and pairEligibleFrag follow, so the picker never offers this either.
  if (a.settle_status !== 'settled' || b.settle_status !== 'settled') {
    return c.json({ error: 'Both payments must have settled before they can be grouped' }, 400);
  }
  if (Number(a.amount) !== Number(b.amount)) return c.json({ error: 'Amounts differ' }, 400);
  if (a.order_id && b.order_id && a.order_id !== b.order_id) {
    return c.json({ error: 'Legs are linked to different orders — unlink one first' }, 400);
  }
  // Pairing merges two groups, so every piece of per-group state has to end up
  // agreeing: a lone value spreads, two different ones are a decision only the
  // manager can make. Without this the feed — which renders the PayPal leg
  // alone — would silently swallow whatever sat on the Mercury one.
  if (a.assignee_id && b.assignee_id && a.assignee_id !== b.assignee_id) {
    return c.json({ error: 'Legs are assigned to different members — unassign one first' }, 400);
  }
  if (a.internal_txn_id && b.internal_txn_id && a.internal_txn_id !== b.internal_txn_id) {
    return c.json({ error: 'Legs belong to different internal transactions — remove one first' }, 400);
  }
  if ((a.internal_txn_id || b.internal_txn_id) && (a.order_id || b.order_id)) {
    return c.json({ error: 'A leg in an internal transaction cannot be paired with one linked to a purchase order' }, 400);
  }

  const linked = a.order_id ? a : b.order_id ? b : null;
  const assigned = a.assignee_id ? a : b.assignee_id ? b : null;
  const filed = a.internal_txn_id ? a : b.internal_txn_id ? b : null;
  await sql.begin(async (tx) => {
    const pairId = crypto.randomUUID();
    await tx`UPDATE bank_transactions SET pair_id = ${pairId} WHERE id IN (${a.id}, ${b.id})`;
    if (filed) {
      await tx`
        UPDATE bank_transactions
        SET internal_txn_id = ${filed.internal_txn_id},
            category = 'transfer', category_manual = TRUE
        WHERE pair_id = ${pairId} AND internal_txn_id IS NULL`;
    }
    if (linked) {
      // Clears the owner in the same statement: the CHECK refuses a row that is
      // both linked and assigned, so propagating the link onto an assigned leg
      // would abort the transaction.
      await tx`
        UPDATE bank_transactions
        SET order_id = ${linked.order_id}, link_kind = ${linked.link_kind},
            link_auto = ${linked.link_auto}, linked_by = ${linked.linked_by},
            linked_at = ${linked.linked_at},
            assignee_id = NULL, assigned_by = NULL, assigned_at = NULL
        WHERE pair_id = ${pairId} AND order_id IS NULL`;
    } else if (assigned) {
      await tx`
        UPDATE bank_transactions
        SET assignee_id = ${assigned.assignee_id}, assigned_by = ${c.var.user.id},
            assigned_at = NOW()
        WHERE pair_id = ${pairId} AND assignee_id IS NULL`;
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
  if (group.some((l) => l.order_id)) return c.json({ error: 'Unlink the transaction before ignoring it' }, 400);
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
// transfer-pairing) from overturning it. The verdict also teaches: marking a
// row with a counterparty records a rule that classifies that counterparty's
// other rows now and on every future sync; unmarking retracts it.

function counterpartyRulesOf(group: { source: string; counterparty: string | null }[]) {
  const seen = new Set<string>();
  return group.flatMap((l) => {
    if (!l.counterparty || seen.has(`${l.source}\n${l.counterparty}`)) return [];
    seen.add(`${l.source}\n${l.counterparty}`);
    return [{ source: l.source, counterparty: l.counterparty }];
  });
}

bankTx.post('/:id/mark-transfer', async (c) => {
  const sql = getDb(c.env);
  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  if (group.some((l) => l.order_id)) return c.json({ error: 'Unlink the transaction before marking it a transfer' }, 400);

  const rules = counterpartyRulesOf(group);
  let alsoMarked = 0;
  await sql.begin(async (tx) => {
    await tx`
      UPDATE bank_transactions SET category = 'transfer', category_manual = TRUE
      WHERE id IN ${tx(group.map((l) => l.id))}`;
    for (const r of rules) {
      await tx`
        INSERT INTO bank_transfer_counterparties (source, counterparty, created_by)
        VALUES (${r.source}, ${r.counterparty}, ${c.var.user.id})
        ON CONFLICT (source, counterparty) DO NOTHING`;
      const updated = await tx`
        UPDATE bank_transactions SET category = 'transfer'
        WHERE source = ${r.source} AND counterparty = ${r.counterparty}
          AND category = 'external' AND NOT category_manual AND order_id IS NULL
          -- Money that never moved is not a transfer, and reclassifying it
          -- would count it in the Transfers tile it is kept out of.
          AND settle_status = 'settled'`;
      alsoMarked += updated.count;
    }
  });
  return c.json({ ok: true, ruleCounterparty: rules[0]?.counterparty ?? null, alsoMarked });
});

bankTx.post('/:id/unmark-transfer', async (c) => {
  const sql = getDb(c.env);
  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  // Otherwise the row is filed under an internal transaction and back in the
  // unlinked queue at the same time.
  if (group.some((l) => l.internal_txn_id)) {
    return c.json({ error: 'Remove the transaction from its internal transaction first' }, 400);
  }

  const rules = counterpartyRulesOf(group);
  let ruleRemoved = false;
  await sql.begin(async (tx) => {
    await tx`
      UPDATE bank_transactions SET category = 'external', category_manual = TRUE
      WHERE id IN ${tx(group.map((l) => l.id))}`;
    for (const r of rules) {
      const del = await tx`
        DELETE FROM bank_transfer_counterparties
        WHERE source = ${r.source} AND counterparty = ${r.counterparty}`;
      if (del.count === 0) continue;
      ruleRemoved = true;
      // Rows the rule classified carry no manual flag — revert them with it.
      await tx`
        UPDATE bank_transactions SET category = 'external'
        WHERE source = ${r.source} AND counterparty = ${r.counterparty}
          AND category = 'transfer' AND NOT category_manual AND order_id IS NULL`;
    }
  });
  return c.json({ ok: true, ruleRemoved });
});

// ─── Assign / unassign ───────────────────────────────────────────────────────
// Who an unexplained payment belongs to. Unlike every other verdict here this
// one does NOT take the row off the queue: the payment still needs an answer,
// it now just has someone to answer it. A PO link is the answer, which is why
// the two are mutually exclusive (enforced by a CHECK in migrations/0116).

bankTx.post('/:id/assign', async (c) => {
  const sql = getDb(c.env);
  const body = await c.req.json<{ userId?: string }>().catch(() => ({} as { userId?: string }));
  const userId = body.userId?.trim();
  if (!userId || !UUID_RE.test(userId)) return c.json({ error: 'userId is required' }, 400);

  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  if (group.some((l) => l.order_id)) return c.json({ error: 'Unlink the transaction before assigning it' }, 400);
  // Nothing to explain: no money moved, so there is no payment to own.
  if (group.some(isDead)) return c.json({ error: 'This payment did not settle' }, 400);

  // Deactivated members are soft-deleted, so an id alone isn't enough.
  const [member] = await sql<{ name: string }[]>`
    SELECT name FROM users WHERE id = ${userId} AND active LIMIT 1`;
  if (!member) return c.json({ error: 'Member not found' }, 404);

  await sql`
    UPDATE bank_transactions
    SET assignee_id = ${userId}, assigned_by = ${c.var.user.id}, assigned_at = NOW()
    WHERE id IN ${sql(group.map((l) => l.id))}`;
  return c.json({ ok: true, assignee: { id: userId, name: member.name } });
});

bankTx.post('/:id/unassign', async (c) => {
  const sql = getDb(c.env);
  const group = await groupOf(sql, c.req.param('id'));
  if (group.length === 0) return c.json({ error: 'Not found' }, 404);
  await sql`
    UPDATE bank_transactions
    SET assignee_id = NULL, assigned_by = NULL, assigned_at = NULL
    WHERE id IN ${sql(group.map((l) => l.id))}`;
  return c.json({ ok: true });
});

// ─── Link-picker suggestions ─────────────────────────────────────────────────
// Ranked candidates, computed at read time and never persisted (see
// banktx/match.ts). Amount + date proximity while the box is untouched; free
// text takes over the moment the manager types, because then they know
// something the ranking doesn't.

bankTx.get('/:id/suggestions', async (c) => {
  const sql = getDb(c.env);
  const [leg] = await groupOf(sql, c.req.param('id'));
  if (!leg) return c.json({ error: 'Not found' }, 404);
  const q = c.req.query('q')?.trim() ?? '';

  if (!q) {
    const { ranked, total } = await fetchCandidates(sql, {
      id: leg.id,
      amount: Number(leg.amount),
      posted_at: leg.posted_at,
      counterparty: leg.counterparty,
      paypal_txn_id: leg.paypal_txn_id,
    });
    // `total` is the uncapped pool: the list is truncated and saying so is the
    // difference between "these are all of them" and "keep looking".
    return c.json({ suggestions: ranked, total });
  }

  type OrderRow = {
    id: string; total_cost: number | null; created_at: Date; lifecycle: string;
    created_by_name: string | null; seller_name: string | null; txn_hit: boolean;
  };
  const like = `%${escapeLike(q)}%`;
  // The identifier lookup is not a text search — pasting the txn id shown on
  // the row has to find the PO carrying it even though nothing about it is
  // "like" anything, and it outranks every fuzzy hit. Archived POs stay out,
  // matching the no-q path; POST /:id/link would otherwise accept one.
  const txnHit = sql`(UPPER(o.paypal_txn_id) = UPPER(${q})
    OR EXISTS (SELECT 1 FROM packages pt
               WHERE pt.order_id = o.id AND UPPER(pt.paypal_txn_id) = UPPER(${q})))`;
  const rows = await sql<OrderRow[]>`
    SELECT o.id, o.total_cost::float AS total_cost, o.created_at, o.lifecycle,
           u.name AS created_by_name,
           ${txnHit} AS txn_hit,
           (SELECT p.seller_name FROM packages p
            WHERE p.order_id = o.id AND p.seller_name ILIKE ${like} LIMIT 1) AS seller_name
    FROM orders o JOIN users u ON u.id = o.user_id
    WHERE o.archived_at IS NULL
      AND (o.id ILIKE ${like} OR u.name ILIKE ${like}
           OR EXISTS (SELECT 1 FROM packages p2
                      WHERE p2.order_id = o.id AND p2.seller_name ILIKE ${like})
           OR ${txnHit})
    ORDER BY txn_hit DESC, o.created_at DESC LIMIT 10`;
  return c.json({
    suggestions: rows.map((r) => ({
      id: r.id,
      totalCost: r.total_cost === null ? null : Number(r.total_cost),
      createdAt: r.created_at,
      lifecycle: r.lifecycle,
      createdByName: r.created_by_name,
      reason: (r.txn_hit ? 'txn' : 'search') as 'txn' | 'search',
      dayGap: null,
      amountDiff: null,
      confidence: 'low' as const,
      linkedTotal: 0,
      sellerName: r.seller_name,
      affinity: false,
      covered: false,
    })),
    total: rows.length,
  });
});

export default bankTx;
