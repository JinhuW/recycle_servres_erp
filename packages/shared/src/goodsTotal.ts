// `orders.total_cost` is a PO's goods total — what the lines cost, before the
// order-level fees charged on top of it.
//
// It is USUALLY a denormalization of the lines, kept as a column so a list can
// read one number instead of aggregating. But it is not only that: it can also
// be a negotiated lot price, a figure the purchaser actually paid that no line
// arithmetic produces. No screen can enter one any more, so every value written
// from now on is a mirror — but orders taken before that can hold a real one,
// and recomputing those would quietly rewrite what the business paid.
//
// The two are told apart by whether the stored value still equals the line sum
// BEFORE the lines move: a mirror does, a negotiated price doesn't. Afterwards
// a stale mirror and a real override look exactly alike.
//
// The rule lives here because both sides have to reach the same verdict. The
// backend takes it at the top of the write transaction; an editor takes it
// against the subtotal its page loaded with. A client that decides differently
// from the server shows the user one figure and stores another.

/** A cent. Below this, a stored goods total IS the line sum. */
export const GOODS_EPSILON = 0.01;

/**
 * Whether a stored goods total tracks the lines rather than standing apart from
 * them. `lineSubtotal` must be the sum as it stood BEFORE any pending edit.
 *
 * An order with no stored total counts as a mirror: there is no figure to
 * protect, and deriving one is the whole point.
 */
export function goodsTotalIsMirror(
  storedGoods: number | null | undefined,
  lineSubtotal: number,
): boolean {
  if (storedGoods == null) return true;
  return Math.abs(storedGoods - lineSubtotal) < GOODS_EPSILON;
}
