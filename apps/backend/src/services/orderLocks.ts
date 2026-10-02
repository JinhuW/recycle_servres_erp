import type { SqlLike } from '../db';

// One lock order for every transaction that writes a PO and its lines: the
// orders rows first, sorted by id, then the lines. PATCH /api/orders/:id and
// the lifecycle advance already lock the order before touching a line; a
// writer that locks lines first and then updates `orders` (the goods-total
// sync after an inventory edit or a sell-order Done) waits on the order while
// holding the very lines PATCH is waiting for, and Postgres aborts one of the
// two with 40P01.
//
// FOR NO KEY UPDATE, like every other non-deleting order lock: it still
// serialises PO writers, but it does not block the FOR KEY SHARE an FK check
// takes when a transfer inserts a line under the order.

export async function lockOrdersTx(tx: SqlLike, orderIds: readonly string[]): Promise<void> {
  const ids = [...new Set(orderIds)].sort();
  if (ids.length === 0) return;
  await tx`
    SELECT id FROM orders WHERE id = ANY(${ids}::text[])
    ORDER BY id
    FOR NO KEY UPDATE
  `;
}

/** Locks the orders owning these lines; returns their ids. */
export async function lockOrdersForLinesTx(tx: SqlLike, lineIds: readonly string[]): Promise<string[]> {
  if (lineIds.length === 0) return [];
  const rows = await tx<{ order_id: string }[]>`
    SELECT DISTINCT order_id FROM order_lines WHERE id = ANY(${[...lineIds]}::uuid[])
  `;
  const orderIds = rows.map((r) => r.order_id);
  await lockOrdersTx(tx, orderIds);
  return orderIds;
}
