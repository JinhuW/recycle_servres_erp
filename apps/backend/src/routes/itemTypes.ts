// The `Other` line type vocabulary. Read happens through /api/lookups (the
// boot cache); this route only writes. Anyone may add a type inline from the
// line drawer — a purchaser blocked mid-entry by an unlisted part is worse
// than a slightly untidy list — while renaming and retiring stay with
// managers.

import { Hono } from 'hono';
import { getDb } from '../db';
import type { Env, User } from '../types';

const itemTypes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

export const ITEM_TYPE_MAX = 40;

/** Trim and collapse internal runs of whitespace; '' when there's nothing left. */
export function normalizeItemType(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
}

// The management list: retired types included, plus how many lines carry each
// one so a manager can see what a rename or retire would affect. The picker
// itself reads the active set out of /api/lookups instead.
itemTypes.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql<{ id: string; name: string; active: boolean; uses: number }[]>`
    SELECT l.id, l.name, l.active,
           (SELECT COUNT(*)::int FROM order_lines ol WHERE ol.item_type = l.name) AS uses
      FROM item_types l
     ORDER BY l.active DESC, lower(l.name)
  `;
  return c.json({ items: rows });
});

itemTypes.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
  const name = normalizeItemType(body?.name);
  if (!name) return c.json({ error: 'name required' }, 400);
  if (name.length > ITEM_TYPE_MAX) {
    return c.json({ error: `name must be ${ITEM_TYPE_MAX} characters or fewer` }, 400);
  }

  const sql = getDb(c.env);
  // Idempotent on lower(name): typing "cpu" when "CPU" exists selects the
  // existing type instead of minting a twin. A retired type is revived
  // rather than duplicated.
  const [row] = await sql<{ id: string; name: string }[]>`
    INSERT INTO item_types (name, created_by)
    VALUES (${name}, ${c.var.user.id})
    ON CONFLICT (lower(name)) DO UPDATE SET active = TRUE
    RETURNING id, name
  `;
  return c.json(row, 201);
});

itemTypes.patch('/:id', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const body = (await c.req.json().catch(() => null)) as
    | { name?: unknown; active?: unknown }
    | null;
  if (!body) return c.json({ error: 'body required' }, 400);
  if (body.active !== undefined && typeof body.active !== 'boolean') {
    return c.json({ error: 'active must be a boolean' }, 400);
  }
  const active: boolean | null = typeof body.active === 'boolean' ? body.active : null;

  let name: string | null = null;
  if (body.name !== undefined) {
    name = normalizeItemType(body.name);
    if (!name) return c.json({ error: 'name required' }, 400);
    if (name.length > ITEM_TYPE_MAX) {
      return c.json({ error: `name must be ${ITEM_TYPE_MAX} characters or fewer` }, 400);
    }
  }

  const sql = getDb(c.env);
  const id = c.req.param('id');

  try {
    type Updated = { id: string; name: string; active: boolean } | null;
    const updated: Updated = await sql.begin(async (tx): Promise<Updated> => {
      const [existing] = await tx<{ id: string; name: string }[]>`
        SELECT id, name FROM item_types WHERE id = ${id}
      `;
      if (!existing) return null;

      const [row] = await tx<{ id: string; name: string; active: boolean }[]>`
        UPDATE item_types
           SET name   = COALESCE(${name}, name),
               active = COALESCE(${active}, active)
         WHERE id = ${id}
        RETURNING id, name, active
      `;

      // order_lines stores the type name, so a rename has to sweep the lines
      // carrying the old one or history silently splits in two.
      if (name && name !== existing.name) {
        await tx`
          UPDATE order_lines SET item_type = ${name} WHERE item_type = ${existing.name}
        `;
      }
      return row;
    });

    if (!updated) return c.json({ error: 'Not found' }, 404);
    return c.json(updated);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return c.json({ error: 'a type with that name already exists' }, 409);
    }
    throw err;
  }
});

export default itemTypes;
