import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const dashboard = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// One round-trip dashboard payload: KPIs, an 8-week sparkline, leaderboard, and
// recent activity. Manager sees team-wide; purchaser sees only their own.
dashboard.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  const isManager = u.role === 'manager';

  // Manager sees all rows; purchaser is scoped to their own user_id. The
  // fragment evaluates to TRUE for managers so it composes into AND chains
  // without leaving stray syntax.
  const scopeFrag = isManager ? sql`TRUE` : sql`o.user_id = ${u.id}`;

  // KPIs (last 30d window matches the prototype's "Last 30 days · …")
  const kpis = (await sql`
    SELECT
      COUNT(DISTINCT o.id)::int                                AS count,
      COALESCE(SUM(l.unit_cost * l.qty), 0)::float             AS cost,
      COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float AS revenue,
      COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit,
      COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty * 0.075), 0)::float AS commission
    FROM orders o
    JOIN order_lines l ON l.order_id = o.id
    WHERE o.created_at >= NOW() - INTERVAL '30 days'
      AND ${scopeFrag}
  `)[0];

  // Weekly sparkline — 8 buckets ending today.
  const weeks = await sql`
    WITH series AS (
      SELECT generate_series(
        date_trunc('week', NOW()) - INTERVAL '7 weeks',
        date_trunc('week', NOW()),
        INTERVAL '1 week'
      ) AS week_start
    )
    SELECT
      to_char(s.week_start, 'IW')                            AS label,
      COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit
    FROM series s
    LEFT JOIN orders o ON o.created_at >= s.week_start
                       AND o.created_at < s.week_start + INTERVAL '1 week'
                       AND ${scopeFrag}
    LEFT JOIN order_lines l ON l.order_id = o.id
    GROUP BY s.week_start
    ORDER BY s.week_start
  `;

  // Top contributors (purchasers only) — used by both roles, but only managers
  // see the full list; purchasers see their rank.
  const leaderboardRaw = await sql<{
    id: string; name: string; initials: string; email: string; role: string;
    count: number; revenue: number; profit: number; commission: number;
  }[]>`
    SELECT u.id, u.name, u.initials, u.email, u.role,
           COUNT(DISTINCT o.id)::int AS count,
           COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float AS revenue,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty * 0.075), 0)::float AS commission
    FROM users u
    JOIN orders o ON o.user_id = u.id
    JOIN order_lines l ON l.order_id = o.id
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
      commission: showFinancials ? row.commission : null,
    };
  });

  // Per-category breakdown (RAM / SSD / Other) over the same 30d window.
  const byCatRows = await sql`
    SELECT l.category,
           COUNT(*)::int                                                AS count,
           COALESCE(SUM(COALESCE(l.sell_price, l.unit_cost) * l.qty), 0)::float AS revenue,
           COALESCE(SUM((COALESCE(l.sell_price, l.unit_cost) - l.unit_cost) * l.qty), 0)::float AS profit
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    WHERE o.created_at >= NOW() - INTERVAL '30 days'
      AND ${scopeFrag}
    GROUP BY l.category
  `;
  const byCat: Record<string, { count: number; revenue: number; profit: number }> = {};
  for (const r of byCatRows as unknown as { category: string; count: number; revenue: number; profit: number }[]) {
    byCat[r.category] = { count: r.count, revenue: r.revenue, profit: r.profit };
  }

  // Recent activity — latest 4 lines, with denormalized user info for the row.
  const recentRows = await sql<Record<string, unknown>[]>`
    SELECT l.id, l.category, l.brand, l.capacity, l.type, l.interface, l.description,
           l.rpm, l.health::float AS health,
           l.qty, l.unit_cost::float AS unit_cost, l.sell_price::float AS sell_price,
           o.created_at, o.id AS order_id,
           u.id AS user_id, u.name AS user_name, u.initials AS user_initials
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    JOIN users u  ON u.id = o.user_id
    ${isManager ? sql`` : sql`WHERE o.user_id = ${u.id}`}
    ORDER BY o.created_at DESC, l.position ASC
    LIMIT 4
  `;
  // Match inventory's role-based cost-strip (PRD §6.8): purchasers don't see unit_cost.
  const recent = isManager
    ? recentRows
    : recentRows.map(({ unit_cost: _uc, ...rest }) => rest);

  return c.json({
    role: u.role,
    kpis,
    weeks,
    leaderboard,
    byCat,
    recent,
  });
});

export default dashboard;
