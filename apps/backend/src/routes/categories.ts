import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const categories = new Hono<{ Bindings: Env; Variables: { user: User } }>();

categories.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, label, icon, enabled, ai_capture, requires_pn,
           default_margin::float AS default_margin, position
    FROM categories ORDER BY position
  `;
  return c.json({ items: rows });
});

categories.post('/', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { id: string; label: string; icon?: string; enabled?: boolean;
        aiCapture?: boolean; requiresPn?: boolean; defaultMargin?: number; position?: number }
    | null;
  if (!body?.id || !body?.label) return c.json({ error: 'id and label required' }, 400);
  const sql = getDb(c.env);
  try {
    await sql`
      INSERT INTO categories (id, label, icon, enabled, ai_capture, requires_pn, default_margin, position)
      VALUES (${body.id}, ${body.label}, ${body.icon ?? 'box'},
              ${body.enabled ?? true}, ${body.aiCapture ?? false}, ${body.requiresPn ?? false},
              ${body.defaultMargin ?? 30}, ${body.position ?? 99})
    `;
  } catch (e) {
    if (/duplicate/i.test((e as { message?: string }).message ?? '')) {
      return c.json({ error: `category ${body.id} already exists` }, 409);
    }
    throw e;
  }
  return c.json({ id: body.id }, 201);
});

categories.patch('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { label?: string; icon?: string; enabled?: boolean; aiCapture?: boolean;
        requiresPn?: boolean; defaultMargin?: number; position?: number }
    | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const sql = getDb(c.env);
  const r = await sql`
    UPDATE categories SET
      label          = COALESCE(${body.label ?? null}, label),
      icon           = COALESCE(${body.icon ?? null}, icon),
      enabled        = COALESCE(${body.enabled ?? null}, enabled),
      ai_capture     = COALESCE(${body.aiCapture ?? null}, ai_capture),
      requires_pn    = COALESCE(${body.requiresPn ?? null}, requires_pn),
      default_margin = COALESCE(${body.defaultMargin ?? null}, default_margin),
      position       = COALESCE(${body.position ?? null}, position)
    WHERE id = ${id} RETURNING id
  `;
  if (r.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

export default categories;
