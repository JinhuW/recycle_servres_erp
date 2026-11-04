---
id: RS-522
title: Fill a PO's sell prices from its linked sell orders
type: story
status: done
priority: P2
created: 2026-11-04
reporter: jinhu
branch: JinhuW/kelpfish
pr: 1081
version: 1.416.0
related: [RS-347, RS-323]
---

## Ask

> help me create an button to auto fill the sell price in the PO. 
> It should auto fill the sell price in the linked sell order and keep in mind this manager only access. 
> do not expose any info to the purchaser.

## Context

Review mode (`DesktopBoxCheck.tsx`, RS-323) is where the commission's sell price
is set, through `PATCH /api/inventory/:id`. A manager could type a price, use
**Fill from market**, or drop a sell order sheet (RS-347). When a sell order
already named the PO's lines, its price was in the ERP and still had to be
re-entered. `sell_order_lines.inventory_id` links a sell line to its PO line, and
`unit_price` is always USD, even on a CNY order.

Sell orders are manager-only. A purchaser can already read a line's sell price on
their own PO, because their commission is paid on it, so the price itself stays
visible and only its origin is hidden.

## Acceptance criteria

- [x] `GET /api/orders/:id/sell-order-prices` returns `{ lines: [{ lineId, price }] }` and writes nothing. It carries no sell order id or customer.
- [x] A purchaser gets 403, including on their own PO. The role check runs before the lookup, so the response doesn't reveal whether a PO exists.
- [x] The price is the qty-weighted average, rounded to cents, over sell orders naming the line. Closed and archived orders are skipped, as are sell lines at qty 0 or price 0.
- [x] Review mode has a **From sell order** button beside **Fill from market** and **From sheet**.
- [x] The button overwrites a differing price and leaves a matching or unlinked line alone. One refused line doesn't stop the others.
- [x] The toast reports how many lines were priced, or says no linked sell order has a price.
- [x] After a fill, a purchaser's PO detail and line history show the price as a plain `priced` change, with no sell order id, customer or source.
- [x] Strings exist in English and Chinese.

## Out of scope

Writing prices back to the sell order; the mobile shell (Review mode is desktop
only); the PO edit page's Ready to Pay price table; hiding the sell price from
purchasers (they need it for commission); a preview step before the write.

## Notes

Owner decisions, 2026-11-04: the purchaser sees the price only, a differing price
is overwritten, and every sell order counts except Closed ones.

"In the linked sell order" was read as the direction sell order to PO; the sell
order is not changed.

Unlike the final sell price, this skips an archived Done order, so a line sold
only on one shows a final sell price that the button will not fill.

There is no Undo, unlike the sheet's Apply: each change is in the line's history,
but an old price has to be restored by hand.
