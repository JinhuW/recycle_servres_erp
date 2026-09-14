import { Hono } from 'hono';
import { isPricedSellPrice } from '@recycle-erp/shared';
import { getDb } from '../db';
import { effectiveRole } from '../lib/role';
import { effUnitCost, poFeeBasis } from '../lib/po-cost';
import type { Env, User } from '../types';

const dashboard = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, 'ytd': 365 };

dashboard.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  // A manager previewing as a purchaser (tweaks.rolePreview) is scoped to their
  // own work, matching the orders list — every KPI, the leaderboard financials,
  // and the recent-activity feed key off this so the two layers can't disagree.
  const role = effectiveRole(u);
  const isManager = role === 'manager';
  const range = c.req.query('range') ?? '30d';
  const days = RANGE_DAYS[range] ?? 30;
  // The leaderboard's ranking metric. It has to be chosen here, not in the
  // client: a purchaser receives every peer row's money as null, so the SPA
  // cannot re-sort. Column aliases only — the query value never reaches SQL.
  const lbSort = c.req.query('lb') === 'commission' ? 'commission' : 'cost';
  const lbOrder = lbSort === 'commission'
    ? sql`commission DESC, cost DESC, u.name`
    : sql`cost DESC, commission DESC, u.name`;

  // Two financial lenses, never mixed on one screen — keyed off effectiveRole:
  //  - Managers see REALIZED sales: revenue/profit/commission from
  //    sell_order_lines of Done sell orders, priced at sol.unit_price, team-wide.
  //  - Purchasers see PROJECTED profit from their OWN reviewed purchase orders —
  //    the margin "set" on each line, (sell_price - unit_cost) * qty. It lands on
  //    the dashboard the moment the PO reaches Ready to Pay: that is when the
  //    commission becomes owed, and Done only records that it was paid.
  // A line nobody has priced is not a sale at cost. Its NULL sell_price drops
  // out of every SUM below, and the recent-activity rows state no profit rather
  // than $0 — the strip sits directly under the KPI tiles, so a row claiming a
  // margin the tiles never counted would answer one question two ways.
  const saleDateWin = sql`so.status = 'Done' AND so.updated_at >= NOW() - (${days} || ' days')::interval`;
  // Previous equal-length window, immediately before the current one — used for
  // KPI trend deltas. Half-open: [-2d, -d) so the boundary day isn't counted twice.
  const salePrevWin = sql`so.status = 'Done'
                          AND so.updated_at >= NOW() - (${days * 2} || ' days')::interval
                          AND so.updated_at <  NOW() - (${days}     || ' days')::interval`;
  // Projected windows key off the PO's own created_at; only the purchaser's reviewed POs count.
  const projDateWin = sql`po.lifecycle IN ('ready_to_pay', 'done') AND po.user_id = ${u.id}
                          AND po.created_at >= NOW() - (${days} || ' days')::interval`;
  const projPrevWin = sql`po.lifecycle IN ('ready_to_pay', 'done') AND po.user_id = ${u.id}
                          AND po.created_at >= NOW() - (${days * 2} || ' days')::interval
                          AND po.created_at <  NOW() - (${days}     || ' days')::interval`;
  // The "Recent activity" panel always tracks ingest (the purchasing pipeline).
  const poScopeFrag = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  const poDateWin   = sql`o.created_at >= NOW() - (${days} || ' days')::interval`;
  // Weekly chart spans the selected range, in weekly buckets.
  const chartWeeksBack = Math.max(1, Math.ceil(days / 7)) - 1;

  // A PO's order-level other_fees, pushed down to the line so the cost/profit/
  // commission formulas below stay line-level. Revenue is never touched — a fee
  // is a cost. See lib/po-cost.ts for the allocation rule.
  const feeBasis = poFeeBasis(sql);
  const eff = effUnitCost(sql);

  const [totals, prevTotals, cntRows, weeks, leaderboardRaw, byCatRows, recentRows] =
    await Promise.all([
      // KPI totals — realized (manager) or projected from Done POs (purchaser).
      isManager
        ? sql<{ revenue: number; cost: number; profit: number; commission: number }[]>`
            SELECT
              COALESCE(SUM(sol.unit_price * sol.qty), 0)::float                              AS revenue,
              COALESCE(SUM(${eff}         * sol.qty), 0)::float                              AS cost,
              COALESCE(SUM((sol.unit_price - ${eff}) * sol.qty), 0)::float                   AS profit,
              COALESCE(SUM((sol.unit_price - ${eff}) * sol.qty
                           * COALESCE(po.commission_rate, 0)), 0)::float                     AS commission
            FROM sell_order_lines sol
            JOIN sell_orders so ON so.id = sol.sell_order_id
            JOIN order_lines ol ON ol.id = sol.inventory_id
            JOIN orders po      ON po.id = ol.order_id
            ${feeBasis}
            WHERE ${saleDateWin}
          `
        : sql<{ revenue: number; cost: number; profit: number; commission: number }[]>`
            SELECT
              COALESCE(SUM(ol.sell_price * ol.qty), 0)::float                  AS revenue,
              -- Filtered to the SAME lines revenue and profit are drawn from.
              -- An unpriced line's NULL drops out of those two SUMs on its own;
              -- cost summing every line regardless would leave the KPI row
              -- stating a revenue and a cost that don't reconcile to its own
              -- profit. Cost here is the cost OF the priced lines.
              COALESCE(SUM(${eff} * ol.qty)
                       FILTER (WHERE ol.sell_price IS NOT NULL), 0)::float                             AS cost,
              COALESCE(SUM((ol.sell_price - ${eff}) * ol.qty), 0)::float       AS profit,
              COALESCE(SUM((ol.sell_price - ${eff}) * ol.qty
                           * COALESCE(po.commission_rate, 0)), 0)::float                               AS commission
            FROM order_lines ol
            JOIN orders po ON po.id = ol.order_id
            ${feeBasis}
            WHERE ${projDateWin}
          `,
      // Previous-period revenue/profit — only what the KPI trend chips need.
      isManager
        ? sql<{ revenue: number; profit: number }[]>`
            SELECT
              COALESCE(SUM(sol.unit_price * sol.qty), 0)::float             AS revenue,
              COALESCE(SUM((sol.unit_price - ${eff}) * sol.qty), 0)::float  AS profit
            FROM sell_order_lines sol
            JOIN sell_orders so ON so.id = sol.sell_order_id
            JOIN order_lines ol ON ol.id = sol.inventory_id
            JOIN orders po      ON po.id = ol.order_id
            ${feeBasis}
            WHERE ${salePrevWin}
          `
        : sql<{ revenue: number; profit: number }[]>`
            SELECT
              COALESCE(SUM(ol.sell_price * ol.qty), 0)::float            AS revenue,
              COALESCE(SUM((ol.sell_price - ${eff}) * ol.qty), 0)::float AS profit
            FROM order_lines ol
            JOIN orders po ON po.id = ol.order_id
            ${feeBasis}
            WHERE ${projPrevWin}
          `,
      // Count — distinct Done sell orders (manager) or distinct Done POs (purchaser).
      isManager
        ? sql<{ n: number }[]>`
            SELECT COUNT(DISTINCT so.id)::int AS n
            FROM sell_orders so
            JOIN sell_order_lines sol ON sol.sell_order_id = so.id
            JOIN order_lines ol ON ol.id = sol.inventory_id
            JOIN orders po      ON po.id = ol.order_id
            WHERE ${saleDateWin}
          `
        : sql<{ n: number }[]>`
            SELECT COUNT(DISTINCT po.id)::int AS n
            FROM orders po
            WHERE ${projDateWin}
          `,
      // Profit per week — realized by Done date (manager) or projected by PO
      // created_at (purchaser).
      isManager
        ? sql<{ label: string; profit: number }[]>`
            WITH series AS (
              SELECT generate_series(
                date_trunc('week', NOW()) - (${chartWeeksBack} || ' weeks')::interval,
                date_trunc('week', NOW()),
                INTERVAL '1 week'
              ) AS week_start
            )
            SELECT to_char(s.week_start,'IW') AS label,
                   COALESCE(SUM((sol.unit_price - ${eff}) * sol.qty), 0)::float AS profit
            FROM series s
            LEFT JOIN sell_orders so
              ON so.status = 'Done'
             AND so.updated_at >= s.week_start
             AND so.updated_at <  s.week_start + INTERVAL '1 week'
            LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
            LEFT JOIN order_lines ol ON ol.id = sol.inventory_id
            LEFT JOIN orders po ON po.id = ol.order_id
            ${feeBasis}
            GROUP BY s.week_start ORDER BY s.week_start
          `
        : sql<{ label: string; profit: number }[]>`
            WITH series AS (
              SELECT generate_series(
                date_trunc('week', NOW()) - (${chartWeeksBack} || ' weeks')::interval,
                date_trunc('week', NOW()),
                INTERVAL '1 week'
              ) AS week_start
            )
            SELECT to_char(s.week_start,'IW') AS label,
                   COALESCE(SUM((ol.sell_price - ${eff}) * ol.qty), 0)::float AS profit
            FROM series s
            LEFT JOIN orders po
              ON po.lifecycle IN ('ready_to_pay', 'done')
             AND po.user_id = ${u.id}
             AND po.created_at >= s.week_start
             AND po.created_at <  s.week_start + INTERVAL '1 week'
            ${feeBasis}
            LEFT JOIN order_lines ol ON ol.order_id = po.id
            GROUP BY s.week_start ORDER BY s.week_start
          `,
      // Leaderboard — per purchaser (the PO owner) over their reviewed POs,
      // windowed on the PO created_at, ranked by what they bought (cost) or
      // what it earned (commission). Two CTEs because the metrics live at
      // different grains: cost is a PO-header figure — goods total plus
      // other_fees, the same stack the PO pages call "Total cost" — and would
      // be multiplied by the line count if summed through order_lines; the
      // projected revenue/profit/commission are line-level, same lens as the
      // purchaser dashboard. LEFT JOIN keeps purchasers with no such POs on
      // the board with 0s.
      sql<{
        id: string; name: string; initials: string; email: string; role: string;
        count: number; cost: number; revenue: number; profit: number; commission: number;
      }[]>`
        WITH per_order AS (
          SELECT po.user_id,
                 COUNT(*)::int                                                                AS count,
                 COALESCE(SUM(COALESCE(po.total_cost, fee.goods) + po.other_fees), 0)::float AS cost
          FROM orders po
          ${feeBasis}
          WHERE po.lifecycle IN ('ready_to_pay', 'done') AND po.created_at >= NOW() - (${days} || ' days')::interval
          GROUP BY po.user_id
        ), per_line AS (
          SELECT po.user_id,
                 COALESCE(SUM(ol.sell_price * ol.qty), 0)::float                AS revenue,
                 COALESCE(SUM((ol.sell_price - ${eff}) * ol.qty), 0)::float     AS profit,
                 COALESCE(SUM((ol.sell_price - ${eff}) * ol.qty
                              * COALESCE(po.commission_rate, 0)), 0)::float                             AS commission
          FROM order_lines ol
          JOIN orders po ON po.id = ol.order_id
          ${feeBasis}
          WHERE po.lifecycle IN ('ready_to_pay', 'done') AND po.created_at >= NOW() - (${days} || ' days')::interval
          GROUP BY po.user_id
        )
        SELECT u.id, u.name, u.initials, u.email, u.role,
               COALESCE(po.count,      0)::int   AS count,
               COALESCE(po.cost,       0)::float AS cost,
               COALESCE(pl.revenue,    0)::float AS revenue,
               COALESCE(pl.profit,     0)::float AS profit,
               COALESCE(pl.commission, 0)::float AS commission
        FROM users u
        LEFT JOIN per_order po ON po.user_id = u.id
        LEFT JOIN per_line  pl ON pl.user_id = u.id
        WHERE u.role = 'purchaser'
        ORDER BY ${lbOrder}
      `,
      // Per-category rollup — realized by sale-time snapshot (manager) or
      // projected from Done PO lines (purchaser).
      isManager
        ? sql<{ category: string; count: number; revenue: number; profit: number }[]>`
            SELECT sol.category, COUNT(*)::int AS count,
                   COALESCE(SUM(sol.unit_price * sol.qty), 0)::float                  AS revenue,
                   COALESCE(SUM((sol.unit_price - ${eff}) * sol.qty), 0)::float AS profit
            FROM sell_order_lines sol
            JOIN sell_orders so ON so.id = sol.sell_order_id
            JOIN order_lines ol ON ol.id = sol.inventory_id
            JOIN orders po      ON po.id = ol.order_id
            ${feeBasis}
            WHERE ${saleDateWin}
            GROUP BY sol.category
          `
        : sql<{ category: string; count: number; revenue: number; profit: number }[]>`
            SELECT ol.category, COUNT(*)::int AS count,
                   COALESCE(SUM(ol.sell_price * ol.qty), 0)::float                  AS revenue,
                   COALESCE(SUM((ol.sell_price - ${eff}) * ol.qty), 0)::float AS profit
            FROM order_lines ol
            JOIN orders po ON po.id = ol.order_id
            ${feeBasis}
            WHERE ${projDateWin}
            GROUP BY ol.category
          `,
      // Recent activity — tracks ingest (purchasing), not sales, so it stays
      // PO-line based with the PO date window.
      sql<Record<string, unknown>[]>`
        SELECT l.id, l.category, l.brand, l.capacity, l.type, l.interface, l.description,
               l.rpm, l.health::float AS health,
               l.qty, l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price,
               o.created_at, o.id AS order_id,
               u.id AS user_id, u.name AS user_name, u.initials AS user_initials
        FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN users u ON u.id = o.user_id
        WHERE ${poDateWin} AND ${poScopeFrag} ORDER BY o.created_at DESC, l.position ASC LIMIT 4
      `,
    ]);

  const t = totals[0];
  const p = prevTotals[0];
  const r2dp = (v: number) => Math.round(v * 100) / 100;
  const revenue    = r2dp(t.revenue);
  const cost       = r2dp(t.cost);
  const profit     = r2dp(t.profit);
  const commission = r2dp(t.commission);
  const prev = { revenue: r2dp(p.revenue), profit: r2dp(p.profit) };
  const cnt = cntRows[0].n;

  // Top contributors (purchasers only). A purchaser sees everyone's rank but
  // only their own financials (PRD §6.8).
  const leaderboard = leaderboardRaw.map(row => {
    const showFinancials = isManager || row.id === u.id;
    return {
      id: row.id, name: row.name, initials: row.initials,
      email: showFinancials ? row.email : null, role: row.role,
      count: row.count,
      cost: showFinancials ? r2dp(row.cost) : null,
      revenue: showFinancials ? r2dp(row.revenue) : null,
      profit: showFinancials ? r2dp(row.profit) : null,
      commission: showFinancials ? r2dp(row.commission) : null,
    };
  });

  const byCat: Record<string, { count: number; revenue: number; profit: number }> = {};
  for (const r of byCatRows) byCat[r.category] = { count: r.count, revenue: r2dp(r.revenue), profit: r2dp(r.profit) };

  // Recent activity — latest 4 ingest lines. Compute projected profit per row
  // before the cost-strip (purchasers don't see unit_cost per PRD §6.8).
  const recent = recentRows.map(r => {
    const unitCost = Number(r.unit_cost) || 0;
    const qty = Number(r.qty) || 0;
    // null, not 0 — the same figure the spreadsheet's per-line profit reports
    // for an unpriced line, and the clients render it as an em-dash.
    const sellPrice = r.sell_price as number | null;
    const profit = isPricedSellPrice(sellPrice) ? (Number(sellPrice) - unitCost) * qty : null;
    const { unit_cost, ...rest } = r;
    return isManager ? { ...rest, unit_cost, profit } : { ...rest, profit };
  });

  return c.json({
    role,
    kpis: { count: cnt, cost, revenue, profit, commission, prev },
    weeks: weeks.map(w => ({ ...w, profit: r2dp(w.profit) })),
    leaderboard, byCat, recent,
  });
});

export default dashboard;
