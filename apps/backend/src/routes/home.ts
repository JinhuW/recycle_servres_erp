import { Hono } from 'hono';
import { REPORTING_TZ } from '@recycle-erp/shared';
import { getDb } from '../db';
import { allLimited } from '../lib/concurrency';
import { effectiveRole } from '../lib/role';
import { poRealizedLateral } from '../lib/po-cost';
import { openRowFrag } from '../banktx/match';
import { leaveDraftBlockers, readCutoffs } from '../services/orderTxnRule';
import { fingerprintSql } from '../services/sellOrderSignoff';
import { stageSinceSql, unackedRevertFrag } from './orders/shared';
import { inboundCounts } from './packages';
import { reviewCounts } from './accounting';
import type { Env, User } from '../types';

// Home: what is waiting on the viewer, one request for the whole page. Every
// count here reads the same predicate as the page its tile opens — through the
// shared helper where one exists — so Home never says 3 to a list showing 2.
// Lists are short on purpose; the page they link to is the full queue.
const home = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const LIST_MAX = 6;
// "Done lately" and "paid lately" share one window.
const RECENT_DAYS = 30;

type Sql = ReturnType<typeof getDb>;

home.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  // A manager previewing as a purchaser gets the purchaser's Home over their
  // own work, as the dashboard and the orders list do.
  const role = effectiveRole(u);
  if (role === 'manager') return c.json({ role, manager: await managerHome(sql, u) });
  return c.json({ role, purchaser: await purchaserHome(sql, u) });
});

async function purchaserHome(sql: Sql, u: User) {
  const since = stageSinceSql(sql, sql`o`);
  const mine = sql`o.user_id = ${u.id} AND o.archived_at IS NULL`;
  const commission = sql`(GREATEST(rz.projected_profit, 0) * COALESCE(o.commission_rate, 0))`;

  const [stageRows, openRows, pkgCounts, pkgRows, money, followRows, cutoffs] = await allLimited([
    () => sql<{ lifecycle: string; n: number }[]>`
      SELECT o.lifecycle, COUNT(*)::int AS n FROM orders o
      WHERE ${mine}
        AND (o.lifecycle <> 'done' OR ${since} >= NOW() - make_interval(days => ${RECENT_DAYS}))
      GROUP BY o.lifecycle`,
    // Drafts first (they wait on the purchaser), then the longest-waiting.
    () => sql<{
      id: string; lifecycle: string; since: string; lines: number; cost: number;
      supplier: string | null; payment: string; payment_method: string | null; paypal_txn_id: string | null;
      created_at: Date; total_cost: number | null; warehouse_id: string | null; source: string | null;
      handoff_method: string | null; handoff_by: string | null; has_package: boolean;
      pkg_status: string | null; pkg_tracking_status: string | null; pkg_eta: string | null; pkg_carrier: string | null;
    }[]>`
      SELECT o.id, o.lifecycle, ${since} AS since,
             (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id)::int AS lines,
             (COALESCE(o.total_cost, 0) + o.other_fees)::float AS cost,
             sup.name AS supplier,
             o.payment, o.payment_method, o.paypal_txn_id, o.created_at, o.total_cost,
             o.warehouse_id, o.source, o.handoff_method, o.handoff_by,
             (p.id IS NOT NULL) AS has_package,
             p.status AS pkg_status, p.tracking_status AS pkg_tracking_status,
             p.tracking_eta AS pkg_eta, p.carrier AS pkg_carrier
      FROM orders o
      LEFT JOIN suppliers sup ON sup.id = o.supplier_id
      LEFT JOIN LATERAL (
        SELECT * FROM packages p WHERE p.order_id = o.id ORDER BY p.created_at DESC, p.id DESC LIMIT 1
      ) p ON TRUE
      WHERE ${mine} AND o.lifecycle <> 'done'
      ORDER BY (o.lifecycle = 'draft') DESC, since ASC
      LIMIT ${LIST_MAX}`,
    () => inboundCounts(sql, u, true),
    () => packageRows(sql, sql`p.created_by = ${u.id}`),
    () => sql<{ owed: number; owed_count: number; paid_recent: number }[]>`
      SELECT COALESCE(SUM(${commission}) FILTER (WHERE o.lifecycle = 'ready_to_pay'), 0)::float AS owed,
             COUNT(*) FILTER (WHERE o.lifecycle = 'ready_to_pay')::int AS owed_count,
             COALESCE(SUM(${commission}) FILTER (
               WHERE o.lifecycle = 'done' AND ${since} >= NOW() - make_interval(days => ${RECENT_DAYS})), 0)::float AS paid_recent
      FROM orders o
      ${poRealizedLateral(sql, true)}
      WHERE ${mine} AND o.lifecycle IN ('ready_to_pay', 'done')`,
    // The supplier book's due states (services/supplierCrm.ts dueStateFor):
    // past or today is due, within a week is soon.
    () => sql<{ id: string; name: string; next_follow_up_at: string; days_until: number }[]>`
      SELECT s.id, s.name, to_char(s.next_follow_up_at, 'YYYY-MM-DD') AS next_follow_up_at,
             (s.next_follow_up_at - CURRENT_DATE)::int AS days_until
      FROM suppliers s
      WHERE s.owner_id = ${u.id} AND s.status IN ('prospect', 'active')
        AND s.next_follow_up_at <= CURRENT_DATE + 7
      ORDER BY s.next_follow_up_at, s.name`,
    () => readCutoffs(sql),
  ]);

  const stages: Record<string, number> = { draft: 0, in_transit: 0, reviewing: 0, ready_to_pay: 0, done: 0 };
  for (const r of stageRows) stages[r.lifecycle] = r.n;
  const openCount = stages.draft + stages.in_transit + stages.reviewing + stages.ready_to_pay;

  // The same list the hand-off refuses on, for the few drafts shown.
  const openPos = [];
  for (const r of openRows) {
    const blockers = r.lifecycle === 'draft'
      ? (await leaveDraftBlockers(sql, r, { cutoffs })).map(b => b.kind)
      : undefined;
    openPos.push({
      id: r.id, lifecycle: r.lifecycle, since: r.since, lines: r.lines, cost: r.cost, supplier: r.supplier,
      package: r.pkg_status
        ? { status: r.pkg_status, trackingStatus: r.pkg_tracking_status, eta: r.pkg_eta, carrier: r.pkg_carrier }
        : null,
      ...(blockers ? { blockers } : {}),
    });
  }

  const [m] = money;
  return {
    stages,
    openPos: { count: openCount, items: openPos },
    packages: { ...pkgCounts, items: pkgRows },
    commission: { owed: m.owed, owedCount: m.owed_count, paidRecent: m.paid_recent, recentDays: RECENT_DAYS },
    followUps: {
      due: followRows.filter(r => r.days_until <= 0).length,
      soon: followRows.filter(r => r.days_until > 0).length,
      items: followRows.slice(0, LIST_MAX).map(r => ({
        id: r.id, name: r.name, nextFollowUpAt: r.next_follow_up_at, daysUntil: r.days_until,
      })),
    },
  };
}

// Moving boxes and the ones needing a hand, in the inbound-counts buckets.
// Problems first, then the nearest ETA; a box with no ETA yet goes last.
function packageRows(sql: Sql, scope: ReturnType<Sql>) {
  return sql<{
    id: string; carrier: string; trackingNumber: string; status: string; trackingStatus: string | null;
    eta: string | null; orderId: string | null; creator: string | null;
  }[]>`
    SELECT p.id, p.carrier, p.tracking_number AS "trackingNumber", p.status,
           p.tracking_status AS "trackingStatus", p.tracking_eta AS eta, p.order_id AS "orderId",
           u.name AS creator
    FROM packages p
    LEFT JOIN users u ON u.id = p.created_by
    WHERE ${scope}
      AND (p.status IN ('purchased', 'in_transit', 'exception')
           OR (p.status = 'delivered' AND p.order_id IS NULL))
    ORDER BY (p.status = 'exception' OR p.status = 'delivered') DESC, p.tracking_eta ASC NULLS LAST, p.created_at
    LIMIT ${LIST_MAX}`;
}

async function managerHome(sql: Sql, u: User) {
  const since = stageSinceSql(sql, sql`o`);
  const live = sql`o.archived_at IS NULL`;
  // "Today" and "tomorrow" are business days, as on the dashboard.
  const today = sql`(NOW() AT TIME ZONE ${REPORTING_TZ})::date`;

  const [
    inbound, inboundExtra, inboundRows, reviewRows, revertRows, ready,
    sellRows, packingRows, signoffRows, bank, rmb, queues,
  ] = await allLimited([
    () => inboundCounts(sql, u, false),
    () => sql<{ arriving: number; pickups: number }[]>`
      SELECT
        (SELECT COUNT(*) FROM packages p
         WHERE p.status IN ('purchased', 'in_transit')
           AND (p.tracking_eta AT TIME ZONE ${REPORTING_TZ})::date <= ${today} + 1)::int AS arriving,
        -- A pickup crosses town with no box to track; it is incoming all the same.
        (SELECT COUNT(*) FROM orders o
         WHERE o.lifecycle = 'in_transit' AND o.handoff_method = 'pickup' AND ${live})::int AS pickups`,
    () => packageRows(sql, sql`TRUE`),
    // Oldest first, the way a queue is cleared. A line counts as checked only
    // on the manager's tick, never on its count (Review mode's own rule).
    () => sql<{
      id: string; purchaser: string; since: string; lines: number; checked: number;
      findings: number; manager_id: string | null; manager: string | null;
    }[]>`
      SELECT o.id, pu.name AS purchaser, ${since} AS since,
             (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id)::int AS lines,
             (SELECT COUNT(*) FROM order_lines l JOIN order_line_checks k ON k.line_id = l.id
              WHERE l.order_id = o.id AND k.checked_at IS NOT NULL)::int AS checked,
             (SELECT COUNT(*) FROM po_ai_findings f JOIN po_ai_reviews r ON r.id = f.review_id
              WHERE f.order_id = o.id AND r.status = 'done' AND f.resolution IS NULL
                AND f.severity IN ('error', 'warn'))::int AS findings,
             o.manager_id, mu.name AS manager
      FROM orders o
      JOIN users pu ON pu.id = o.user_id
      LEFT JOIN users mu ON mu.id = o.manager_id
      WHERE o.lifecycle = 'reviewing' AND ${live}
      ORDER BY since ASC`,
    // A purchaser's edit after submitting, no manager has looked at yet.
    () => sql<{ id: string; purchaser: string; at: string }[]>`
      SELECT o.id, pu.name AS purchaser, MAX(e.created_at) AS at
      FROM orders o
      JOIN users pu ON pu.id = o.user_id
      JOIN order_events e ON e.order_id = o.id AND e.kind = 'reverted'
      WHERE ${live} AND ${unackedRevertFrag(sql, sql`o.id`)}
      GROUP BY o.id, pu.name
      ORDER BY at ASC`,
    // Commission is owed once the review is finished (accounting's commission lens).
    () => sql<{ count: number; commission: number }[]>`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(GREATEST(rz.projected_profit, 0) * COALESCE(o.commission_rate, 0)), 0)::float AS commission
      FROM orders o
      ${poRealizedLateral(sql, true)}
      WHERE o.lifecycle = 'ready_to_pay' AND ${live}`,
    () => sql<{ status: string; n: number; connector: number }[]>`
      SELECT so.status, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE so.created_by IS NULL)::int AS connector
      FROM sell_orders so
      WHERE so.archived_at IS NULL AND so.status IN ('Draft', 'Packing', 'Shipped', 'Awaiting payment')
      GROUP BY so.status`,
    // Ticked lines over all lines: a rough bar, not Pack mode's own count,
    // which also distrusts a tick whose qty was edited since.
    () => sql<{ id: string; customer: string; lines: number; packed: number }[]>`
      SELECT so.id, cu.name AS customer,
             (SELECT COUNT(*) FROM sell_order_lines sol WHERE sol.sell_order_id = so.id)::int AS lines,
             (SELECT COUNT(*) FROM sell_order_packs pk
              WHERE pk.sell_order_id = so.id AND pk.packed_at IS NOT NULL)::int AS packed
      FROM sell_orders so
      JOIN customers cu ON cu.id = so.customer_id
      WHERE so.archived_at IS NULL AND so.status = 'Packing'
      ORDER BY so.updated_at ASC
      LIMIT ${LIST_MAX}`,
    // Orders on their way to Done that this manager has not signed as they
    // stand — no row, or one an edit since has voided.
    () => sql<{ id: string; customer: string; status: string }[]>`
      SELECT so.id, cu.name AS customer, so.status
      FROM sell_orders so
      JOIN customers cu ON cu.id = so.customer_id
      LEFT JOIN sell_order_signoffs s ON s.sell_order_id = so.id AND s.user_id = ${u.id}
      WHERE so.archived_at IS NULL AND so.status IN ('Shipped', 'Awaiting payment')
        AND (s.fingerprint IS NULL OR s.fingerprint <> ${fingerprintSql(sql, sql`so`)})
      ORDER BY so.updated_at ASC`,
    // The Payments page's Unlinked and Disputes tiles, money out — the lens
    // the page opens on (routes/bankTx.ts /stats).
    () => sql<{ unlinked: number; unlinked_amount: number; disputes: number }[]>`
      SELECT COUNT(*) FILTER (WHERE ${openRowFrag(sql, 'bt')} AND bt.amount < 0)::int AS unlinked,
             COALESCE(SUM(ABS(bt.amount)) FILTER (WHERE ${openRowFrag(sql, 'bt')} AND bt.amount < 0), 0)::float
               AS unlinked_amount,
             COUNT(*) FILTER (WHERE bt.dispute IS NOT NULL AND bt.amount < 0)::int AS disputes
      FROM bank_transactions bt
      WHERE bt.pair_id IS NULL OR bt.source = 'paypal'`,
    () => reviewCounts(sql, u.id),
    () => sql<{ after_sales: number; after_sales_mine: number; transfers: number; web: number }[]>`
      SELECT
        (SELECT COUNT(*) FROM after_sales_cases a WHERE a.status NOT IN ('Resolved', 'Cancelled'))::int AS after_sales,
        (SELECT COUNT(*) FROM after_sales_cases a
         WHERE a.status NOT IN ('Resolved', 'Cancelled') AND a.assignee_id = ${u.id})::int AS after_sales_mine,
        (SELECT COUNT(*) FROM transfer_orders t WHERE t.status = 'Pending')::int AS transfers,
        (SELECT COUNT(*) FROM web_submissions w WHERE w.status = 'new')::int AS web`,
  ]);

  const so = Object.fromEntries(sellRows.map(r => [r.status, r])) as Record<string, { n: number; connector: number }>;
  const [x] = inboundExtra;
  const [b] = bank;
  const [q] = queues;
  return {
    inbound: { ...inbound, arriving: x.arriving, pickups: x.pickups, items: inboundRows },
    review: {
      count: reviewRows.length,
      mine: reviewRows.filter(r => r.manager_id === u.id).length,
      items: reviewRows.slice(0, LIST_MAX).map(r => ({
        id: r.id, purchaser: r.purchaser, since: r.since, lines: r.lines, checked: r.checked,
        findings: r.findings, manager: r.manager, mine: r.manager_id === u.id,
      })),
    },
    reverts: { count: revertRows.length, items: revertRows.slice(0, LIST_MAX) },
    readyToPay: ready[0],
    sales: {
      draft: so.Draft?.n ?? 0,
      draftConnector: so.Draft?.connector ?? 0,
      packing: so.Packing?.n ?? 0,
      shipped: so.Shipped?.n ?? 0,
      awaitingPayment: so['Awaiting payment']?.n ?? 0,
      packingItems: packingRows,
    },
    signoffs: { count: signoffRows.length, items: signoffRows.slice(0, LIST_MAX) },
    bank: { unlinked: b.unlinked, unlinkedAmount: b.unlinked_amount, disputes: b.disputes },
    rmb,
    queues: {
      afterSales: q.after_sales, afterSalesMine: q.after_sales_mine, transfers: q.transfers, web: q.web,
    },
  };
}

export default home;
