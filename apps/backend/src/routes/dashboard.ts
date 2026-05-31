import { Hono } from 'hono';
import { getDb } from '../db';
import { effectiveRole } from '../lib/role';
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

  // Realized financials: revenue/profit/commission come from sell_order_lines
  // of Done sell orders, priced at sol.unit_price (NOT the PO-side sell_price,
  // which is a projection — different scope entirely). Commission is credited
  // to the purchaser whose PO brought the source inventory in. Manual sell-
  // order lines (inventory_id IS NULL) are excluded — no source PO, no
  // purchaser to credit.
  const saleScopeFrag = isManager ? sql`TRUE` : sql`po.user_id = ${u.id}`;
  const saleDateWin   = sql`so.status = 'Done' AND so.updated_at >= NOW() - (${days} || ' days')::interval`;
  // Previous equal-length window, immediately before the current one — used for
  // KPI trend deltas. Half-open: [-2d, -d) so the boundary day isn't counted twice.
  const salePrevWin   = sql`so.status = 'Done'
                            AND so.updated_at >= NOW() - (${days * 2} || ' days')::interval
                            AND so.updated_at <  NOW() - (${days}     || ' days')::interval`;
  // The "Recent activity" panel still tracks ingest (the purchasing pipeline),
  // not sales, so it keeps the PO-side date scoping.
  const poScopeFrag = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  const poDateWin   = sql`o.created_at >= NOW() - (${days} || ' days')::interval`;
  // Weekly chart spans the selected range, in weekly buckets.
  const chartWeeksBack = Math.max(1, Math.ceil(days / 7)) - 1;

  const [totals, prevTotals, cntRows, weeks, leaderboardRaw, byCatRows, recentRows] =
    await Promise.all([
      // KPI totals — realized.
      sql<{ revenue: number; cost: number; profit: number; commission: number }[]>`
        SELECT
          COALESCE(SUM(sol.unit_price * sol.qty), 0)::float                              AS revenue,
          COALESCE(SUM(ol.unit_cost   * sol.qty), 0)::float                              AS cost,
          COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty), 0)::float             AS profit,
          COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty
                       * COALESCE(po.commission_rate, 0)), 0)::float                     AS commission
        FROM sell_order_lines sol
        JOIN sell_orders so ON so.id = sol.sell_order_id
        JOIN order_lines ol ON ol.id = sol.inventory_id
        JOIN orders po      ON po.id = ol.order_id
        WHERE ${saleDateWin} AND ${saleScopeFrag}
      `,
      // Previous-period revenue/profit — only what the KPI trend chips need.
      sql<{ revenue: number; profit: number }[]>`
        SELECT
          COALESCE(SUM(sol.unit_price * sol.qty), 0)::float                  AS revenue,
          COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty), 0)::float AS profit
        FROM sell_order_lines sol
        JOIN sell_orders so ON so.id = sol.sell_order_id
        JOIN order_lines ol ON ol.id = sol.inventory_id
        JOIN orders po      ON po.id = ol.order_id
        WHERE ${salePrevWin} AND ${saleScopeFrag}
      `,
      // Number of distinct Done sell orders in the window (scope-filtered).
      sql<{ n: number }[]>`
        SELECT COUNT(DISTINCT so.id)::int AS n
        FROM sell_orders so
        JOIN sell_order_lines sol ON sol.sell_order_id = so.id
        JOIN order_lines ol ON ol.id = sol.inventory_id
        JOIN orders po      ON po.id = ol.order_id
        WHERE ${saleDateWin} AND ${saleScopeFrag}
      `,
      // Realized profit per week, bucketed by the sell order's Done date.
      sql<{ label: string; profit: number }[]>`
        WITH series AS (
          SELECT generate_series(
            date_trunc('week', NOW()) - (${chartWeeksBack} || ' weeks')::interval,
            date_trunc('week', NOW()),
            INTERVAL '1 week'
          ) AS week_start
        )
        SELECT to_char(s.week_start,'IW') AS label,
               COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty), 0)::float AS profit
        FROM series s
        LEFT JOIN sell_orders so
          ON so.status = 'Done'
         AND so.updated_at >= s.week_start
         AND so.updated_at <  s.week_start + INTERVAL '1 week'
        LEFT JOIN sell_order_lines sol ON sol.sell_order_id = so.id
        LEFT JOIN order_lines ol ON ol.id = sol.inventory_id
        LEFT JOIN orders po      ON po.id = ol.order_id
                                AND (${isManager}::boolean OR po.user_id = ${u.id})
        GROUP BY s.week_start ORDER BY s.week_start
      `,
      // Leaderboard — realized per purchaser (the PO owner). LEFT JOIN keeps
      // purchasers with zero realized sales on the board with 0s.
      sql<{
        id: string; name: string; initials: string; email: string; role: string;
        count: number; revenue: number; profit: number; commission: number;
      }[]>`
        WITH per_user AS (
          SELECT po.user_id,
                 COUNT(*)::int                                                                  AS count,
                 COALESCE(SUM(sol.unit_price * sol.qty), 0)::float                              AS revenue,
                 COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty), 0)::float             AS profit,
                 COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty
                              * COALESCE(po.commission_rate, 0)), 0)::float                     AS commission
          FROM sell_order_lines sol
          JOIN sell_orders so ON so.id = sol.sell_order_id
          JOIN order_lines ol ON ol.id = sol.inventory_id
          JOIN orders po      ON po.id = ol.order_id
          WHERE so.status = 'Done' AND so.updated_at >= NOW() - (${days} || ' days')::interval
          GROUP BY po.user_id
        )
        SELECT u.id, u.name, u.initials, u.email, u.role,
               COALESCE(pu.count,      0)::int   AS count,
               COALESCE(pu.revenue,    0)::float AS revenue,
               COALESCE(pu.profit,     0)::float AS profit,
               COALESCE(pu.commission, 0)::float AS commission
        FROM users u
        LEFT JOIN per_user pu ON pu.user_id = u.id
        WHERE u.role = 'purchaser'
        ORDER BY profit DESC
      `,
      // Per-category realized rollup. sol.category is the snapshot taken at
      // sale time and is what reporting should reflect.
      sql<{ category: string; count: number; revenue: number; profit: number }[]>`
        SELECT sol.category, COUNT(*)::int AS count,
               COALESCE(SUM(sol.unit_price * sol.qty), 0)::float                  AS revenue,
               COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty), 0)::float AS profit
        FROM sell_order_lines sol
        JOIN sell_orders so ON so.id = sol.sell_order_id
        JOIN order_lines ol ON ol.id = sol.inventory_id
        JOIN orders po      ON po.id = ol.order_id
        WHERE ${saleDateWin} AND ${saleScopeFrag}
        GROUP BY sol.category
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
    const sellPrice = r.sell_price == null ? unitCost : Number(r.sell_price);
    const qty = Number(r.qty) || 0;
    const projectedProfit = (sellPrice - unitCost) * qty;
    const { unit_cost, ...rest } = r;
    return isManager ? { ...rest, unit_cost, profit: projectedProfit } : { ...rest, profit: projectedProfit };
  });

  return c.json({
    role,
    kpis: { count: cnt, cost, revenue, profit, commission, prev },
    weeks: weeks.map(w => ({ ...w, profit: r2dp(w.profit) })),
    leaderboard, byCat, recent,
  });
});

export default dashboard;
