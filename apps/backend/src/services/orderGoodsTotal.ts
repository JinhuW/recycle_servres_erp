// orders.total_cost is the PO's goods total — what the lines cost, before the
// order-level fees that are charged on top of it.
//
// It is USUALLY a denormalization of the lines, kept as a column so the list's
// keyset sort, the draft picker and the spreadsheet can read one number instead
// of aggregating. But it is not only that: it can also be a negotiated lot
// price, a figure the purchaser actually paid that no line arithmetic produces.
// No screen can enter one any more, so every value written from now on is a
// mirror — but orders taken before that can hold a real one, and recomputing
// those would quietly rewrite what the business paid.
//
// The two are told apart by whether the stored value still equals the line sum
// BEFORE the change: a mirror does, a negotiated price doesn't. Which is why
// `goodsTotalIsMirror` has to be read at the top of the transaction — once the
// lines have moved, a stale mirror and an override look exactly alike.

import type { SqlLike } from './orderAudit';

/** A cent. Below this, a stored goods total IS the line sum. */
const GOODS_EPSILON = 0.01;

async function lineSum(tx: SqlLike, orderId: string): Promise<number> {
  const [row] = await tx<{ sum: number }[]>`
    SELECT COALESCE(SUM(qty * unit_cost), 0)::float AS sum
    FROM order_lines WHERE order_id = ${orderId}
  `;
  return Number(row.sum);
}

/**
 * Whether `orders.total_cost` currently tracks the lines rather than standing
 * apart from them. Read BEFORE any line write, and pass the answer to
 * `syncOrderGoodsTotal` after.
 *
 * An order with no stored total counts as a mirror: there is no figure to
 * protect, and deriving one is the whole point.
 */
export async function goodsTotalIsMirror(tx: SqlLike, orderId: string): Promise<boolean> {
  const [row] = await tx<{ total_cost: number | null }[]>`
    SELECT total_cost::float AS total_cost FROM orders WHERE id = ${orderId} LIMIT 1
  `;
  if (!row || row.total_cost == null) return true;
  return Math.abs(Number(row.total_cost) - await lineSum(tx, orderId)) < GOODS_EPSILON;
}

/**
 * Refresh `orders.total_cost` from the lines. Must run inside the caller's
 * transaction, after the writes that changed them.
 *
 * No-op when `isMirror` is false — that stored figure is a negotiated price and
 * survives every edit to the lines under it.
 */
export async function syncOrderGoodsTotal(
  tx: SqlLike,
  orderId: string,
  isMirror: boolean,
): Promise<void> {
  if (!isMirror) return;
  await tx`
    UPDATE orders SET total_cost = ${await lineSum(tx, orderId)}
    WHERE id = ${orderId}
  `;
}
