---
id: RS-060
title: PO lines show the final sell price to managers
type: story
status: in-progress
priority: P2
created: 2026-09-17
reporter: jinhu
branch: feat/po-final-sell-price
pr:
version:
related: [RS-051, RS-054]
---

## Ask

> I would like to add a new fied for each item in each PO called final sell price which comes from sells orders.
> At the same time, the final sell price is only available for manager and not editable in the PO directly.

Then, on the plan:

> i want to explain more about it. The current sell order in the PO is for calculating the commission fees for purchaser, BUt it does not meant that the item in  the po has already been sold out.
> The final sell prirce is more like that order has been completed.

## Context

A PO line carries `sell_price`, shown as "Sell / Unit": a manager's
projected price that feeds the purchaser's commission. It says nothing
about whether the units sold. The price they actually sold for lives only
on `sell_order_lines.unit_price` (USD, already prorated by any negotiated
adjustment), linked back to the PO line by `inventory_id`, and no PO read
path joined it — the spreadsheet export still says "a PO has no sell-side
data of its own".

"Completed" is a sell order in status Done: the only status every
realized-revenue query in the system counts (`routes/me.ts`,
`routes/dashboard.ts`, `services/members.ts`). Draft, Shipped and Awaiting
payment can still be repriced; Closed is cancelled.

A PO line can sell across several sell orders, or partially (a partial Done
sale reduces the line's `qty` to the remainder; a full one flips it to
Sold). So the figure is the qty-weighted average unit price over the Done
sell-order lines that name the PO line, and the API also returns how many
units that average covers — without it a price on a partially sold line
has no quantity to read it against.

The value is computed on read and never stored on `order_lines`, which is
what makes it non-editable: the line drawer, the phone line editor and the
PATCH payload builders are untouched.

## Acceptance criteria

- [ ] `GET /api/orders/:id` returns `finalSellPrice` and `finalSoldQty` on
      every line: the qty-weighted average `unit_price` and unit count over
      Done sell orders naming the line, `null` when nothing has sold.
- [ ] Both are `null` for a purchaser (including the PO's owner) and for a
      manager previewing as purchaser.
- [ ] Draft, Shipped, Awaiting payment and Closed sell orders do not count.
- [ ] Desktop PO detail table and the PO list's expanded lines show a
      manager-only "Final sell price" column; purchasers see no column.
- [ ] Phone PO detail line cards and the phone PO list's expanded lines show
      the figure to managers only, and only on lines that have one.
- [ ] Partial sales show a muted `×n` after the price when the sold count
      differs from the line's current qty.
- [ ] No edit surface exposes the field.

## Out of scope

- The PO spreadsheet export and the PO list aggregates (`revenue`,
  `profit` still use the projected `sell_price`).
- Linking each line to the sell orders it sold on.
- Native-currency display; the column is USD like Unit cost.

## Notes

- Beyond the literal ask: `finalSoldQty` and the `×n` suffix, for the
  partial-sale reason above.
- No migration; the existing `sell_order_lines_inventory_idx` covers the
  lookup.
