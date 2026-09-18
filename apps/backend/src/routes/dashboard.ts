import { Hono } from 'hono';
import { isPricedSellPrice } from '@recycle-erp/shared';
import { getDb } from '../db';
import { effectiveRole } from '../lib/role';
import { effUnitCost, poFeeBasis } from '../lib/po-cost';
import { parseReportingWindow, windowBounds } from '../lib/reporting-window';
import { contributions } from '../services/contributions';
import type { Env, User } from '../types';

const dashboard = new Hono<{ Bindings: Env; Variables: { user: User } }>();

dashboard.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  // A manager previewing as a purchaser (tweaks.rolePreview) is scoped to their
  // own work, matching the orders list — every KPI, the leaderboard financials,
  // and the recent-activity feed key off this so the two layers can't disagree.
  const role = effectiveRole(u);
  const isManager = role === 'manager';

  const win = parseReportingWindow({
    from: c.req.query('from'), to: c.req.query('to'),
    range: c.req.query('range'), bucket: c.req.query('bucket'),
  });
  if (!win) return c.json({ error: 'invalid_range' }, 400);
  const { start, end, prevStart, prevEnd } = windowBounds(sql, win);
  const tz = win.tz;
  const bucket = win.bucket;

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
  //
  // Every window is half-open on business-zone calendar days, and the previous
  // window is the equal-length one ending the day before, so a boundary day is
  // never counted twice.
  const saleDateWin = sql`so.status = 'Done' AND so.updated_at >= ${start} AND so.updated_at < ${end}`;
  const salePrevWin = sql`so.status = 'Done' AND so.updated_at >= ${prevStart} AND so.updated_at < ${prevEnd}`;
  // Projected windows key off the PO's own created_at; only the purchaser's reviewed POs count.
  const projDateWin = sql`po.lifecycle IN ('ready_to_pay', 'done') AND po.user_id = ${u.id}
                          AND po.created_at >= ${start} AND po.created_at < ${end}`;
  const projPrevWin = sql`po.lifecycle IN ('ready_to_pay', 'done') AND po.user_id = ${u.id}
                          AND po.created_at >= ${prevStart} AND po.created_at < ${prevEnd}`;
  // Spend — what the PO pages call "Total cost" — over every PO past Draft in
  // the window, scoped to the caller for the purchaser lens. Money is committed
  // the moment a PO is submitted; the leaderboard's narrower Ready-to-Pay/Done
  // rule is about when commission is owed, not about what was spent.
  const spendWin = isManager
    ? sql`po.lifecycle <> 'draft' AND po.created_at >= ${start} AND po.created_at < ${end}`
    : sql`po.lifecycle <> 'draft' AND po.user_id = ${u.id}
          AND po.created_at >= ${start} AND po.created_at < ${end}`;
  // The "Recent activity" panel always tracks ingest (the purchasing pipeline).
  const poScopeFrag = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;
  const poDateWin   = sql`o.created_at >= ${start} AND o.created_at < ${end}`;

  // A PO's order-level other_fees, pushed down to the line so the cost/profit/
  // commission formulas below stay line-level. Revenue is never touched — a fee
  // is a cost. See lib/po-cost.ts for the allocation rule.
  const feeBasis = poFeeBasis(sql);
  const eff = effUnitCost(sql);
  const headerCost = sql`COALESCE(po.total_cost, fee.goods) + po.other_fees`;

  // Chart buckets are business-zone calendar units. Each row is keyed by the
  // bucket its own timestamp falls in, and the rows are the window's rows, so a
  // partial first or last bucket carries only what the tiles counted.
  const bucketOf = (col: ReturnType<typeof sql>) =>
    sql`date_trunc(${bucket}, ${col} AT TIME ZONE ${tz})`;
  const seriesFrag = sql`
    SELECT generate_series(
      date_trunc(${bucket}, ${win.from}::date::timestamp),
      date_trunc(${bucket}, ${win.to}::date::timestamp),
      ${'1 ' + bucket}::interval
    ) AS b`;

  const [totals, prevTotals, cntRows, series, leaderboardRaw, byCatRows, recentRows, boundsRows, contrib] =
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
      // Cashflow series — sales in, spend out, gross profit on what sold; realized
      // by sale date (manager) or projected by PO created_at (purchaser). Spend
      // is the PO header figure, so it is summed at the order grain.
      isManager
        ? sql<{ start: string; revenue: number; cost: number; profit: number }[]>`
            WITH series AS (${seriesFrag}),
            sales AS (
              SELECT ${bucketOf(sql`so.updated_at`)} AS b,
                     SUM(sol.unit_price * sol.qty)            AS revenue,
                     SUM((sol.unit_price - ${eff}) * sol.qty) AS profit
              FROM sell_order_lines sol
              JOIN sell_orders so ON so.id = sol.sell_order_id
              JOIN order_lines ol ON ol.id = sol.inventory_id
              JOIN orders po      ON po.id = ol.order_id
              ${feeBasis}
              WHERE ${saleDateWin}
              GROUP BY 1
            ),
            spend AS (
              SELECT ${bucketOf(sql`po.created_at`)} AS b, SUM(${headerCost}) AS cost
              FROM orders po
              ${feeBasis}
              WHERE ${spendWin}
              GROUP BY 1
            )
            SELECT to_char(s.b, 'YYYY-MM-DD')  AS start,
                   COALESCE(sa.revenue, 0)::float AS revenue,
                   COALESCE(sp.cost,    0)::float AS cost,
                   COALESCE(sa.profit,  0)::float AS profit
            FROM series s
            LEFT JOIN sales sa ON sa.b = s.b
            LEFT JOIN spend sp ON sp.b = s.b
            ORDER BY s.b
          `
        : sql<{ start: string; revenue: number; cost: number; profit: number }[]>`
            WITH series AS (${seriesFrag}),
            sales AS (
              SELECT ${bucketOf(sql`po.created_at`)} AS b,
                     SUM(ol.sell_price * ol.qty)            AS revenue,
                     SUM((ol.sell_price - ${eff}) * ol.qty) AS profit
              FROM order_lines ol
              JOIN orders po ON po.id = ol.order_id
              ${feeBasis}
              WHERE ${projDateWin}
              GROUP BY 1
            ),
            spend AS (
              SELECT ${bucketOf(sql`po.created_at`)} AS b, SUM(${headerCost}) AS cost
              FROM orders po
              ${feeBasis}
              WHERE ${spendWin}
              GROUP BY 1
            )
            SELECT to_char(s.b, 'YYYY-MM-DD')  AS start,
                   COALESCE(sa.revenue, 0)::float AS revenue,
                   COALESCE(sp.cost,    0)::float AS cost,
                   COALESCE(sa.profit,  0)::float AS profit
            FROM series s
            LEFT JOIN sales sa ON sa.b = s.b
            LEFT JOIN spend sp ON sp.b = s.b
            ORDER BY s.b
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
                 COUNT(*)::int                          AS count,
                 COALESCE(SUM(${headerCost}), 0)::float AS cost
          FROM orders po
          ${feeBasis}
          WHERE po.lifecycle IN ('ready_to_pay', 'done') AND po.created_at >= ${start} AND po.created_at < ${end}
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
          WHERE po.lifecycle IN ('ready_to_pay', 'done') AND po.created_at >= ${start} AND po.created_at < ${end}
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
      // The first day there is anything to report — the left edge of the range
      // strip. LEAST skips a NULL side, so one empty table doesn't blank it.
      sql<{ first: string | null }[]>`
        SELECT to_char(LEAST((SELECT MIN(created_at) FROM orders),
                             (SELECT MIN(created_at) FROM sell_orders)) AT TIME ZONE ${tz},
                       'YYYY-MM-DD') AS first
      `,
      contributions(sql, { role, userId: u.id, start, end }),
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
    window: {
      from: win.from, to: win.to, prevFrom: win.prevFrom, prevTo: win.prevTo,
      bucket: win.bucket, bucketAuto: win.bucketAuto, tz: win.tz,
    },
    bounds: { first: boundsRows[0].first },
    kpis: { count: cnt, cost, revenue, profit, commission, prev },
    series: series.map(s => ({
      start: s.start, revenue: r2dp(s.revenue), cost: r2dp(s.cost), profit: r2dp(s.profit),
    })),
    leaderboard, byCat, recent, contrib,
  });
});

export default dashboard;
