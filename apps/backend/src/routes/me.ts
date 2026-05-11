import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const me = new Hono<{ Bindings: Env; Variables: { user: User } }>();

me.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  // Lifetime stats for the Profile screen (count, profit, commission).
  const stats = (await sql`
    SELECT
      COUNT(*)::int                           AS count,
      COALESCE(SUM((sell_price - unit_cost) * qty), 0)::float AS profit,
      COALESCE(SUM((sell_price - unit_cost) * qty * 0.075), 0)::float AS commission
    FROM order_lines l
    JOIN orders o ON o.id = l.order_id
    WHERE o.user_id = ${u.id} AND l.sell_price IS NOT NULL
  `)[0] as { count: number; profit: number; commission: number };

  return c.json({
    user: u,
    stats,
  });
});

me.patch('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { language?: 'en' | 'zh' } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);

  const u = c.var.user;
  const sql = getDb(c.env);
  if (body.language && (body.language === 'en' || body.language === 'zh')) {
    await sql`UPDATE users SET language = ${body.language} WHERE id = ${u.id}`;
  }
  return c.json({ ok: true });
});

export default me;
