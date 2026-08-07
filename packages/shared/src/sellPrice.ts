// What "priced" means for an order line, in one place.
//
// A sell price of 0 means "nobody has priced this line", not "priced at
// nothing". The two sides used to spell that differently — the SQL asked
// `sell_price IS NULL` while every client gated on `> 0` — so a line saved at 0
// was priced to the orders list and unpriced to the cost tape, and the same PO
// reported "2 of 3 lines priced" on one screen and 3 of 3 on the next.
//
// The backend collapses 0 to NULL on write (migration 0086 did the same to the
// rows that predate that), so for stored lines the two forms below agree by
// construction. `isPriced` still tests `> 0` because it also runs against
// unsaved form state, where a 0 is a box that was typed into and left empty.

/** The value to store: anything that isn't a positive number is "unpriced". */
export function normSellPrice(v: number | null | undefined): number | null {
  return v != null && v > 0 ? v : null;
}

/** Whether a sell price — stored or still in a form field — counts as set. */
export function isPricedSellPrice(v: number | string | null | undefined): boolean {
  if (v == null || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}
