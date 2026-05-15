import { Hono } from 'hono';
import { getDb } from '../db';
import { validatePreferencePatch } from '../preferences';
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
