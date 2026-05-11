import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const workspace = new Hono<{ Bindings: Env; Variables: { user: User } }>();

workspace.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql<{ key: string; value: unknown }[]>`SELECT key, value FROM workspace_settings`;
  const settings: Record<string, unknown> = {};
  for (const r of rows) settings[r.key] = r.value;
  return c.json({ settings });
});

workspace.patch('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: 'body required' }, 400);
  const sql = getDb(c.env);
  for (const [k, v] of Object.entries(body)) {
    await sql`
      INSERT INTO workspace_settings (key, value, updated_at)
      VALUES (${k}, ${sql.json(v as never)}, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  }
  return c.json({ ok: true });
});

export default workspace;
