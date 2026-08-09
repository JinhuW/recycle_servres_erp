// Keeping orders.total_cost in step with the lines it usually mirrors. What
// that column means, and how a mirror is told apart from a negotiated lot
// price, is `goodsTotal.ts` in @recycle-erp/shared — the editors apply the same
// rule client-side, so it can only live in one place.
//
// The verdict has to be read at the top of the transaction: once the lines have
// moved, a stale mirror and a real override look exactly alike.

import { goodsTotalIsMirror as storedTotalIsMirror } from '@recycle-erp/shared';
import type { SqlLike } from './orderAudit';

// qty_purchased over qty: a sale takes units off the shelf, and what the PO
// paid for them does not change when it does. Reading qty here made the goods
// total fall on every partial sale, so one PO recorded two different costs
// depending on whether its stock left in one sell order or several. NULL means
// nothing has parted the two.
async function lineSum(tx: SqlLike, orderId: string): Promise<number> {
  const [row] = await tx<{ sum: number }[]>`
    SELECT COALESCE(SUM(COALESCE(qty_purchased, qty) * unit_cost), 0)::float AS sum
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
  // Short-circuited so the sum is only paid for when there is a figure to
  // compare it against.
  if (!row || row.total_cost == null) return true;
  return storedTotalIsMirror(Number(row.total_cost), await lineSum(tx, orderId));
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
