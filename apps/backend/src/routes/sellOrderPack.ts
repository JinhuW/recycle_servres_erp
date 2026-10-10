// Pack mode: a manager ticking a sell order's lines into the box.
import { Hono } from 'hono';
import type postgres from 'postgres';
import { getDb, type SqlLike } from '../db';
import { UUID_RE } from '../lib/pagination';
import { proposalSellStatuses } from '../lib/sellCommitment';
import { writeSellOrderEvent } from '../services/sellOrderAudit';
import { validateSellLines } from '../services/sellOrderCreate';
import type { SOLineSnap } from '../services/sellOrderLineMatch';
import type { Env, User } from '../types';

const packRoutes = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// A line's pack identity. Saving the order's lines deletes and re-inserts
// every row, so the row id can't carry progress: a picked line is its lot, a
// hand-typed line its text. The occurrence number keeps two lines of one
// identity apart — nothing stops the API from naming a lot twice. It counts
// by warehouse and sub-label before position, because a save rewrites
// position in packing-list order: two same-text lines in two warehouses
// would otherwise trade numbers, and their ticks with them.
function keyedLines(sql: SqlLike, orderId: string) {
  return sql`
    SELECT s.id, s.qty, s.inventory_id,
           s.base || '#' || ROW_NUMBER() OVER (
             PARTITION BY s.base
             ORDER BY s.warehouse_id, s.sub_label, s.position, s.created_at, s.id) AS line_key
    FROM (
      SELECT sol.id, sol.qty, sol.inventory_id, sol.position, sol.created_at,
             sol.warehouse_id, sol.sub_label,
             COALESCE(sol.inventory_id::text, 'typed:' || md5(jsonb_build_array(
               sol.category, sol.label, sol.part_number, sol.condition)::text)) AS base
      FROM sell_order_lines sol WHERE sol.sell_order_id = ${orderId}
    ) s`;
}

// Drop the ticks no line on the order answers to any more. Run by whatever
// takes lines off an order, under the order's lock.
export async function prunePackRows(sql: SqlLike, orderId: string) {
  await sql`
    DELETE FROM sell_order_packs p
    WHERE p.sell_order_id = ${orderId}
      AND NOT EXISTS (
        SELECT 1 FROM (${keyedLines(sql, orderId)}) k WHERE k.line_key = p.line_key)`;
}

type PackRow = {
  line_id: string; qty: number; serial_number: string | null;
  line_qty: number | null; counted: number | null; packed_at: Date | null;
};

// A row written against another qty describes units that are no longer the
// line's — except a short pack the order was then edited down to match, which
// is exactly what was asked for.
function readRow(r: PackRow): { counted: number; packedAt: Date | null } {
  // A line held at 0 has nothing to pack, whatever was ticked before it was.
  if (r.qty === 0) return { counted: 0, packedAt: null };
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
    lines: rows.map((r) => ({ lineId: r.line_id, qty: r.qty, serialNumber: r.serial_number, ...readRow(r) })),
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

// On a Draft or Packing order the tick and the order's qty move together: a
// lot packed short or at 0 sells what went in the box, and taking the tick
// back puts the qty back. Neither claims stock until it is promoted, so either
// way costs nothing here. Recorded as the editor's own qty edit would be.
async function setLineQty(
  tx: postgres.TransactionSql, orderId: string, lineId: string, from: number, to: number, actorId: string,
) {
  const [snap] = await tx<SOLineSnap[]>`
    UPDATE sell_order_lines SET qty = ${to} WHERE id = ${lineId}
    RETURNING inventory_id, qty, unit_price::float AS unit_price, condition,
              category, label, sub_label, part_number, warehouse_id`;
  // The negotiated baseline described the old qty, as after an editor save.
  await tx`
    UPDATE sell_orders
       SET pre_adjust_native_total = NULL, adjusted_at = NULL, adjusted_by = NULL, updated_at = NOW()
     WHERE id = ${orderId}`;
  await writeSellOrderEvent(tx, orderId, actorId, 'line_edited', {
    inventoryId: snap!.inventory_id, partNumber: snap!.part_number,
    changes: [{ field: 'qty', from, to }], snapshot: snap,
  });
}

// A re-tick keeps its place in the Packed group; a tick against a new qty is
// a new answer.
async function writePackRow(
  tx: postgres.TransactionSql, orderId: string, lineKey: string,
  rowQty: number, counted: number, packed: boolean, actorId: string,
) {
  await tx`
    INSERT INTO sell_order_packs (sell_order_id, line_key, line_qty, counted, packed_at, updated_by, updated_at)
    VALUES (${orderId}, ${lineKey}, ${rowQty}, ${counted}, ${packed ? tx`NOW()` : null}, ${actorId}, NOW())
    ON CONFLICT (sell_order_id, line_key) DO UPDATE SET
      line_qty = EXCLUDED.line_qty,
      counted = EXCLUDED.counted,
      packed_at = CASE WHEN ${packed} THEN
        CASE WHEN sell_order_packs.line_qty = EXCLUDED.line_qty
             THEN COALESCE(sell_order_packs.packed_at, NOW()) ELSE NOW() END
      END,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()`;
}

type PackedLine = {
  line_key: string; qty: number; inventory_id: string | null;
  was_qty: number | null; was_counted: number | null; was_packed_at: Date | null;
};

packRoutes.put('/:id/pack/:lineId', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const lineId = c.req.param('lineId');
  if (!UUID_RE.test(lineId)) return c.json({ error: 'Not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { counted?: unknown; packed?: unknown } | null;

  type Outcome = { code: 400 | 404 | 409; msg: string } | { code: 200 };
  // The order row before its lines, as the editor's save and status moves lock.
  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const order = (await tx<{ status: string; archived_at: Date | null }[]>`
      SELECT status, archived_at FROM sell_orders WHERE id = ${id} FOR UPDATE`)[0];
    if (!order) return { code: 404, msg: 'Not found' };
    if (order.archived_at) return { code: 409, msg: 'Order is archived — unarchive it first' };
    // Done stays open: an order can be marked paid before it ships.
    if (order.status === 'Closed') return { code: 409, msg: 'Order is closed — reopen it first' };
    if (!body) return { code: 400, msg: 'invalid body' };

    // A 404 here means an edit replaced the line since the page loaded.
    const line = (await tx<PackedLine[]>`
      WITH k AS (${keyedLines(tx, id)})
      SELECT k.line_key, k.qty, k.inventory_id,
             p.line_qty AS was_qty, p.counted AS was_counted, p.packed_at AS was_packed_at
      FROM k
      LEFT JOIN sell_order_packs p ON p.sell_order_id = ${id} AND p.line_key = k.line_key
      WHERE k.id = ${lineId}`)[0];
    if (!line) return { code: 404, msg: 'Not found' };
    const { counted, packed } = body;
    if (typeof packed !== 'boolean') return { code: 400, msg: 'packed must be true or false' };

    // The line still stands where its own tick lowered it, from `was_qty`.
    // A qty edited since no longer matches the count, and is left alone.
    const takesCounts = proposalSellStatuses().includes(order.status);
    const lowered = takesCounts && line.was_packed_at !== null
      && line.was_counted === line.qty && line.was_qty !== null && line.was_qty > line.qty;
    const restoring = lowered && !packed;
    const qty = restoring ? line.was_qty! : line.qty;
    if (qty === 0) return { code: 409, msg: 'This lot is at 0 — there is nothing of it to pack' };
    if (typeof counted !== 'number' || !Number.isInteger(counted) || counted < 0 || counted > qty) {
      return { code: 400, msg: `counted must be a whole number from 0 to ${qty}` };
    }
    // A re-tick of a line its own tick lowered changes nothing; rewriting the
    // row would lose the qty an untick puts back.
    if (lowered && packed && counted === line.qty) return { code: 200 };

    // The qty this row is written against — for a lowered line, the one it
    // was lowered from.
    let rowQty = line.qty;
    if (restoring) {
      // The lot may have been archived or sold since it was lowered.
      if (line.inventory_id) {
        const err = await validateSellLines(tx, [{ inventoryId: line.inventory_id, qty }], id);
        if (err) return { code: 409, msg: err };
      }
      await setLineQty(tx, id, lineId, line.qty, qty, u.id);
      rowQty = qty;
    } else if (takesCounts && packed && counted < line.qty) {
      await setLineQty(tx, id, lineId, line.qty, counted, u.id);
      rowQty = lowered ? line.was_qty! : line.qty;
    }

    await writePackRow(tx, id, line.line_key, rowQty, counted, packed, u.id);
    return { code: 200 };
  });
  if (outcome.code !== 200) return c.json({ error: outcome.msg }, outcome.code);
  return c.json(await readPack(sql, id));
});

type FlaggedLine = { line_id: string; line_key: string; qty: number; counted: number };

// Apply: every lot named that is still lowered and unticked is ticked at its
// count, as its own tick would on a Draft or Packing order — in one
// transaction, so a long order's shorts reach it under one lock rather than a
// PUT apiece. A lot that is no longer lowered (another iPad ticked it, an edit
// rewrote it) is skipped: the page asked about a state that has since moved on.
packRoutes.post('/:id/pack/apply', async (c) => {
  const u = c.var.user;
  if (u.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  const sql = getDb(c.env);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { lineIds?: unknown } | null;
  const ids = body?.lineIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 2000
    || !ids.every(x => typeof x === 'string' && UUID_RE.test(x))) {
    return c.json({ error: 'lineIds must be a list of line ids' }, 400);
  }

  type Outcome = { code: 404 | 409; msg: string } | { code: 200; applied: string[] };
  const outcome: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const order = (await tx<{ status: string; archived_at: Date | null }[]>`
      SELECT status, archived_at FROM sell_orders WHERE id = ${id} FOR UPDATE`)[0];
    if (!order) return { code: 404, msg: 'Not found' };
    if (order.archived_at) return { code: 409, msg: 'Order is archived — unarchive it first' };
    if (!proposalSellStatuses().includes(order.status)) {
      return {
        code: 409,
        msg: `Order is ${order.status} — only a Draft or Packing order takes its counts from the box`,
      };
    }
    // A row written against another qty is stale, and reads as unlowered.
    const flagged = await tx<FlaggedLine[]>`
      WITH k AS (${keyedLines(tx, id)})
      SELECT k.id AS line_id, k.line_key, k.qty, p.counted
      FROM k
      JOIN sell_order_packs p ON p.sell_order_id = ${id} AND p.line_key = k.line_key
      WHERE k.id = ANY(${ids}::uuid[])
        AND k.qty > 0 AND p.line_qty = k.qty AND p.packed_at IS NULL AND p.counted < k.qty`;
    for (const l of flagged) {
      await setLineQty(tx, id, l.line_id, l.qty, l.counted, u.id);
      // Written against the qty it came down from, which an untick puts back.
      await writePackRow(tx, id, l.line_key, l.qty, l.counted, true, u.id);
    }
    return { code: 200, applied: flagged.map(l => l.line_id) };
  });
  if (outcome.code !== 200) return c.json({ error: outcome.msg }, outcome.code);
  return c.json({ ...(await readPack(sql, id)), applied: outcome.applied });
});

export default packRoutes;
