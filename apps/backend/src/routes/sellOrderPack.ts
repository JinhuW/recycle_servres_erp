// Pack mode: a manager ticking a sell order's lines into the box.
import { Hono } from 'hono';
import { getDb, type SqlLike } from '../db';
import { UUID_RE } from '../lib/pagination';
import type { Env, User } from '../types';

const packRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// A line's pack identity. Saving the order's lines deletes and re-inserts
// every row, so the row id can't carry progress: a picked line is its lot, a
// hand-typed line its text. The occurrence number keeps two lines of one
// identity apart — nothing stops the API from naming a lot twice.
function keyedLines(sql: SqlLike, orderId: string) {
  return sql`
    SELECT s.id, s.qty, s.inventory_id,
           s.base || '#' || ROW_NUMBER() OVER (
             PARTITION BY s.base ORDER BY s.position, s.created_at, s.id) AS line_key
    FROM (
      SELECT sol.id, sol.qty, sol.inventory_id, sol.position, sol.created_at,
             COALESCE(sol.inventory_id::text, 'typed:' || md5(jsonb_build_array(
               sol.category, sol.label, sol.part_number, sol.condition)::text)) AS base
      FROM sell_order_lines sol WHERE sol.sell_order_id = ${orderId}
    ) s`;
}

type PackRow = {
  line_id: string; qty: number; serial_number: string | null;
  line_qty: number | null; counted: number | null; packed_at: Date | null;
};

// A row written against another qty describes units that are no longer the
// line's — except a short pack the order was then edited down to match, which
// is exactly what was asked for.
function readRow(r: PackRow): { counted: number; packedAt: Date | null } {
  if (r.line_qty === r.qty) return { counted: r.counted!, packedAt: r.packed_at };
  if (r.packed_at && r.counted === r.qty) return { counted: r.qty, packedAt: r.packed_at };
  return { counted: r.qty, packedAt: null };
}

async function readPack(sql: SqlLike, id: string) {
  const rows = await sql<PackRow[]>`
    WITH k AS (${keyedLines(sql, id)})
    SELECT k.id AS line_id, k.qty, ol.serial_number, p.line_qty, p.counted, p.packed_at
    FROM k
    LEFT JOIN sell_order_packs p ON p.sell_order_id = ${id} AND p.line_key = k.line_key
    LEFT JOIN order_lines ol ON ol.id = k.inventory_id`;
  return {
    lines: rows.map((r) => ({ lineId: r.line_id, serialNumber: r.serial_number, ...readRow(r) })),
  };
}

async function packOrder(sql: SqlLike, id: string) {
  return (await sql<{ status: string; archived_at: Date | null }[]>`
    SELECT status, archived_at FROM sell_orders WHERE id = ${id} LIMIT 1`)[0];
}

// Whole-endpoint gate on the raw role, like every sell-order door.
packRoutes.get('/:id/pack', async (c) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  if (!await packOrder(sql, id)) return c.json({ error: 'Not found' }, 404);
  return c.json(await readPack(sql, id));
});

packRoutes.put('/:id/pack/:lineId', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  const order = await packOrder(sql, id);
  if (!order || !UUID_RE.test(lineId)) return c.json({ error: 'Not found' }, 404);
  if (order.archived_at) return c.json({ error: 'Order is archived — unarchive it first' }, 409);
  // Done stays open: an order can be marked paid before it ships.
  if (order.status === 'Closed') return c.json({ error: 'Order is closed — reopen it first' }, 409);

  const body = (await c.req.json().catch(() => null)) as { counted?: unknown; packed?: unknown } | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  // A 404 here means an edit replaced the line since the page loaded.
  const line = (await sql<{ line_key: string; qty: number }[]>`
    WITH k AS (${keyedLines(sql, id)})
    SELECT line_key, qty FROM k WHERE id = ${lineId}`)[0];
  if (!line) return c.json({ error: 'Not found' }, 404);
  const { counted, packed } = body;
  if (typeof counted !== 'number' || !Number.isInteger(counted) || counted < 0 || counted > line.qty) {
    return c.json({ error: `counted must be a whole number from 0 to ${line.qty}` }, 400);
  }
  if (typeof packed !== 'boolean') return c.json({ error: 'packed must be true or false' }, 400);

  // A re-tick keeps its place in the Packed group; a tick against a new qty
  // is a new answer.
  await sql`
    INSERT INTO sell_order_packs (sell_order_id, line_key, line_qty, counted, packed_at, updated_by, updated_at)
    VALUES (${id}, ${line.line_key}, ${line.qty}, ${counted}, ${packed ? sql`NOW()` : null}, ${u.id}, NOW())
    ON CONFLICT (sell_order_id, line_key) DO UPDATE SET
      line_qty = EXCLUDED.line_qty,
      counted = EXCLUDED.counted,
      packed_at = CASE WHEN ${packed} THEN
        CASE WHEN sell_order_packs.line_qty = EXCLUDED.line_qty
             THEN COALESCE(sell_order_packs.packed_at, NOW()) ELSE NOW() END
      END,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()`;
  return c.json(await readPack(sql, id));
});

export default packRoutes;
