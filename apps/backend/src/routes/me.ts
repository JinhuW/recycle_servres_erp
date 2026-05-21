import { Hono } from 'hono';
import { getDb } from '../db';
import { validatePreferencePatch } from '../preferences';
import type { Env, User } from '../types';

const me = new Hono<{ Bindings: Env; Variables: { user: User } }>();

me.get('/', async (c) => {
  const u = c.var.user;
  const sql = getDb(c.env);
  // Lifetime stats for the Profile screen. Realized model: revenue, profit
  // and commission all come from actual sales (sell_order_lines of Done sell
  // orders), priced at the sell-order unit_price (NOT the PO-side sell_price,
  // which is a projection). Commission is credited to the purchaser whose PO
  // brought the source inventory in. `count` is the number of sold line items
  // attributed to this purchaser.
  const stats = (await sql`
    SELECT
      COUNT(*)::int                                                                AS count,
      COALESCE(SUM(sol.unit_price * sol.qty), 0)::float                            AS revenue,
      COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty), 0)::float           AS profit,
      COALESCE(SUM((sol.unit_price - ol.unit_cost) * sol.qty
                   * COALESCE(po.commission_rate, 0)), 0)::float                   AS commission
    FROM sell_order_lines sol
    JOIN sell_orders so ON so.id = sol.sell_order_id
    JOIN order_lines ol ON ol.id = sol.inventory_id
    JOIN orders po      ON po.id = ol.order_id
    WHERE so.status = 'Done' AND po.user_id = ${u.id}
  `)[0] as { count: number; revenue: number; profit: number; commission: number };

  const r2dp = (v: number) => Math.round(v * 100) / 100;
  return c.json({
    user: u,
    stats: {
      count: stats.count,
      revenue: r2dp(stats.revenue),
      profit: r2dp(stats.profit),
      commission: r2dp(stats.commission),
    },
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

// PATCH /api/me/preferences — partial merge into users.preferences JSONB.
// Body: { [key]: value }. Pass `null` to unset a key. Keys are allowlisted.
me.patch('/preferences', async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = validatePreferencePatch(body);
  if (!result.ok) return c.json({ error: result.error }, result.status);

  const u = c.var.user;
  const sql = getDb(c.env);

  // Read-modify-write. Per-user concurrency is effectively nil (the only
  // writer is the user themselves), and this keeps the merge logic in TS.
  const next: Record<string, unknown> = { ...(u.preferences ?? {}) };
  for (const [k, v] of Object.entries(result.cleaned)) {
    if (v === null) delete next[k];
    else next[k] = v;
  }

  // Mirror language to the column so legacy code paths keep working.
  const nextLanguage =
    'language' in result.cleaned && result.cleaned['language'] !== null
      ? (result.cleaned['language'] as 'en' | 'zh')
      : u.language;

  // Allowlist values are JSON-safe (strings, string unions, string arrays),
  // but TS's strict JSONValue rejects `unknown`; cast at the boundary.
  await sql`
    UPDATE users
       SET preferences = ${sql.json(next as Record<string, never>)}::jsonb,
           language    = ${nextLanguage}
     WHERE id = ${u.id}
  `;

  return c.json({
    user: { ...u, preferences: next, language: nextLanguage },
  });
});

export default me;
