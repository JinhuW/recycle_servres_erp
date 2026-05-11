import { Hono } from 'hono';
import { getDb } from '../db';
import { computeCommission, type Tier } from '../lib/commission-calc';
import type { Env, User } from '../types';

const commission = new Hono<{ Bindings: Env; Variables: { user: User } }>();

commission.get('/tiers', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql<Tier[]>`
    SELECT id, label, floor_pct::float AS "floorPct", rate::float AS rate
    FROM commission_tiers ORDER BY position
  `;
  return c.json({ tiers: rows });
});

commission.put('/tiers', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { tiers: { label: string; floorPct: number; rate: number }[] }
    | null;
  if (!body || !Array.isArray(body.tiers)) return c.json({ error: 'tiers required' }, 400);
  const sql = getDb(c.env);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM commission_tiers`;
    for (let i = 0; i < body.tiers.length; i++) {
      const t = body.tiers[i];
      await tx`
        INSERT INTO commission_tiers (label, floor_pct, rate, position)
        VALUES (${t.label}, ${t.floorPct}, ${t.rate}, ${i})
      `;
    }
  });
  return c.json({ ok: true });
});

commission.get('/preview', async (c) => {
  const profit = Number(c.req.query('profit') ?? '0');
  const margin = Number(c.req.query('margin') ?? '0');
  const sql = getDb(c.env);
  const tiers = await sql<Tier[]>`
    SELECT id, label, floor_pct::float AS "floorPct", rate::float AS rate
    FROM commission_tiers ORDER BY position
  `;
  const revenue = margin > 0 ? profit / margin : 0;
  const result = computeCommission({ profit, revenue }, tiers);
  return c.json(result);
});

commission.get('/settings', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const rows = await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM commission_settings`;
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return c.json({ settings: out });
});

commission.put('/settings', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'body required' }, 400);
  const sql = getDb(c.env);
  for (const [k, v] of Object.entries(body)) {
    await sql`
      INSERT INTO commission_settings (key, value, updated_at)
      VALUES (${k}, ${sql.json(v as never)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  }
  return c.json({ ok: true });
});

export default commission;
