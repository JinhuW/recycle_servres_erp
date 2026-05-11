// Workflow stages — manager-editable lifecycle for orders. Read-only for
// everyone, edit gated to manager.

import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const workflow = new Hono<{ Bindings: Env; Variables: { user: User } }>();

workflow.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, label, short, tone, icon, description, position
    FROM workflow_stages ORDER BY position
  `;
  return c.json({ stages: rows });
});

workflow.put('/', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { stages: { id: string; label: string; short: string; tone: string; icon: string; description?: string }[] }
    | null;
  if (!body || !Array.isArray(body.stages)) return c.json({ error: 'stages required' }, 400);

  const sql = getDb(c.env);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM workflow_stages`;
    for (let i = 0; i < body.stages.length; i++) {
      const s = body.stages[i];
      await tx`
        INSERT INTO workflow_stages (id, label, short, tone, icon, description, position)
        VALUES (${s.id}, ${s.label}, ${s.short}, ${s.tone}, ${s.icon}, ${s.description ?? ''}, ${i})
      `;
    }
  });
  return c.json({ ok: true });
});

export default workflow;
