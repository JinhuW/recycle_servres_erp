# A PO's goods total fell every time its stock sold

`orders.total_cost` is derived from the lines by `services/orderGoodsTotal.ts`.
It summed `qty * unit_cost`. `order_lines.qty` is how many units are still on
the shelf — a sale decrements it — so the derivation was reading remaining
stock and calling it purchased quantity.

The two are the same number right up until something sells, which is why every
test passed.

## What it looked like

A PO of one line, 10 units at $50, `total_cost` $500.

| what happens | qty after | recorded cost |
| --- | --- | --- |
| nothing sells | 10 | $500 |
| sell 4 of 10 | 6 | **$300** |
| sell all 10 in one sell order | 10 | $500 |
| sell 4, then the other 6 | 6 | **$300** |

The PO cost $500 in every row. Two things made it read otherwise:

- A **partial** sale decrements `qty`, so the re-derivation charged the order
  only for what hadn't sold yet.
- A sale that empties a line **keeps** `qty` and just flips the status to
  `'Sold'` — it has to, because of `CHECK (qty > 0)` in `0001_init.sql`. So the
  full-sale path was accidentally correct and the partial path was not, and the
  same goods recorded a different cost depending on how many shipments they
  left in.

That column is the "Total cost" in the orders list and the `Total cost` row of
the PO spreadsheet (`routes/orders.ts`, `goodsCost`).

## Why it was new

`services/orderGoodsTotal.ts` did not exist on `main`. Before this release,
selling inventory never touched `orders.total_cost`. The sell path picked up
`goodsTotalIsMirror` / `syncOrderGoodsTotal` to stop the column going stale
after line edits, and inherited this with it.

## The fix

`order_lines.qty_purchased` (migration `0088`), nullable, where **NULL means
"nothing has parted the two"** — i.e. it equals `qty`. The derivation reads
`COALESCE(qty_purchased, qty)`.

NULL-as-default is what keeps this small: every `INSERT` can go on ignoring the
column, and only the three places that move quantity between rows write it.

- **Partial sale** (`routes/sellOrders.ts`) pins `COALESCE(qty_purchased, qty)`
  before the decrement. Selling a line out leaves `qty` alone, so it still
  speaks for both and stays NULL.
- **Transfer split** (`routes/inventory.ts`) hands the moved share over: the
  source drops by the moved amount, the clone needs nothing of its own because
  no unit has sold from it, so its `qty` already says what it cost.
- **Transfer merge** adds that share back.

## The trap to avoid next time

Do not "fix" this by filtering `lineSum` on status, and do not reach for
zeroing `qty` on a sold-out line — `CHECK (qty > 0)` forbids it, and that
constraint is why the full-sale path retains the quantity in the first place.

The general shape: **`qty` answers "how many are left", not "how many were
bought"**. Any figure about what the business *paid* wants `qty_purchased`.
Anything about what is *on the shelf* wants `qty`.

A cleaner end state would be to split a line on partial sale (a `Sold` row plus
a remaining row) so `qty` is uniform and no second column is needed. That was
not done here because it re-parents photos, serials and `sell_order_lines`
references, which is not a release-branch change.
