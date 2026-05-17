import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const dashboard = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, 'ytd': 365 };

dashboard.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const isManager = u.role === 'manager';
  const range = c.req.query('range') ?? '30d';
  const days = RANGE_DAYS[range] ?? 30;

  const scopeFrag = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;

  const lineRows = await sql<{ qty: number; unit_cost: number; sell_price: number | null }[]>`
    SELECT l.qty, l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.created_at >= NOW() - (${days} || ' days')::interval AND ${scopeFrag}
  `;
  let revenue = 0, cost = 0;
  for (const r of lineRows) {
    const sp = r.sell_price ?? r.unit_cost;
    revenue += sp * r.qty;
    cost += r.unit_cost * r.qty;
  }
  const profit = revenue - cost;

  // Commission is the per-order rate the manager set, applied to that order's
  // profit, summed over the scope. NULL rate = $0.
  const perOrder = await sql<{ profit: number; commission_rate: number | null }[]>`
    SELECT
      COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit,
      o.commission_rate::float AS commission_rate
    FROM orders o
    LEFT JOIN order_lines l ON l.order_id = o.id
    WHERE o.created_at >= NOW() - (${days} || ' days')::interval AND ${scopeFrag}
    GROUP BY o.id, o.commission_rate
  `;
  let commission = 0;
  for (const r of perOrder) commission += r.profit * (r.commission_rate ?? 0);
  commission = +commission.toFixed(2);

  const cnt = (await sql<{ n: number }[]>`
    SELECT COUNT(DISTINCT o.id)::int AS n FROM orders o
    WHERE o.created_at >= NOW() - (${days} || ' days')::interval AND ${scopeFrag}
  `)[0].n;

  const weeks = await sql<{ label: string; profit: number }[]>`
    WITH series AS (
      SELECT generate_series(
        date_trunc('week', NOW()) - INTERVAL '7 weeks',
        date_trunc('week', NOW()),
        INTERVAL '1 week'
      ) AS week_start
    )
    SELECT to_char(s.week_start,'IW') AS label,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit
    FROM series s
    LEFT JOIN orders o ON o.created_at >= s.week_start AND o.created_at < s.week_start + INTERVAL '1 week' AND ${scopeFrag}
    LEFT JOIN order_lines l ON l.order_id = o.id
    GROUP BY s.week_start ORDER BY s.week_start
  `;

  // Top contributors (purchasers only) — used by both roles, but only managers
  // see the full list; purchasers see their rank. Honors the same ?range=
  // window as the rest of the dashboard (PRD §6.8). Commission is computed
  // per-row from profit/revenue via the tier model below (not selected here).
  const leaderboardRaw = await sql<{
    id: string; name: string; initials: string; email: string; role: string;
    count: number; revenue: number; profit: number; commission: number;
  }[]>`
    WITH per_order AS (
      SELECT o.id, o.user_id, o.commission_rate::float AS rate,
             COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float AS revenue,
             COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit
      FROM orders o JOIN order_lines l ON l.order_id = o.id
      WHERE o.created_at >= NOW() - (${days} || ' days')::interval
      GROUP BY o.id, o.user_id, o.commission_rate
    )
    SELECT u.id, u.name, u.initials, u.email, u.role,
           COUNT(DISTINCT po.id)::int AS count,
           COALESCE(SUM(po.revenue), 0)::float AS revenue,
           COALESCE(SUM(po.profit), 0)::float AS profit,
           COALESCE(SUM(po.profit * COALESCE(po.rate, 0)), 0)::float AS commission
    FROM users u JOIN per_order po ON po.user_id = u.id
    WHERE u.role = 'purchaser'
    GROUP BY u.id, u.name, u.initials, u.email, u.role
    ORDER BY profit DESC
  `;
  // A purchaser sees everyone's rank but only their own financials (PRD §6.8).
  const leaderboard = leaderboardRaw.map(row => {
    const showFinancials = isManager || row.id === u.id;
    return {
      id: row.id, name: row.name, initials: row.initials, email: row.email, role: row.role,
      count: row.count,
      revenue: showFinancials ? row.revenue : null,
      profit: showFinancials ? row.profit : null,
      commission: showFinancials ? +row.commission.toFixed(2) : null,
    };
  });

  const byCatRows = await sql<{ category: string; count: number; revenue: number; profit: number }[]>`
    SELECT l.category, COUNT(*)::int AS count,
           COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float AS revenue,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit
    FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.created_at >= NOW() - (${days} || ' days')::interval AND ${scopeFrag}
    GROUP BY l.category
  `;
  const byCat: Record<string, { count: number; revenue: number; profit: number }> = {};
  for (const r of byCatRows) byCat[r.category] = { count: r.count, revenue: r.revenue, profit: r.profit };

  // Recent activity — latest 4 lines, with denormalized user info for the row.
  const recentRows = await sql<Record<string, unknown>[]>`
    SELECT l.id, l.category, l.brand, l.capacity, l.type, l.interface, l.description,
           l.rpm, l.health::float AS health,
           l.qty, l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price,
           o.created_at, o.id AS order_id,
           u.id AS user_id, u.name AS user_name, u.initials AS user_initials
    FROM order_lines l JOIN orders o ON o.id = l.order_id JOIN users u ON u.id = o.user_id
    WHERE ${scopeFrag} ORDER BY o.created_at DESC, l.position ASC LIMIT 4
  `;
  // Match inventory's role-based cost-strip (PRD §6.8): purchasers don't see unit_cost.
  const recent = isManager
    ? recentRows
    : recentRows.map(({ unit_cost: _uc, ...rest }) => rest);

  return c.json({
    role: u.role,
    kpis: { count: cnt, cost, revenue, profit, commission },
    weeks, leaderboard, byCat, recent,
  });
});

export default dashboard;
