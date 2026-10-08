---
id: RS-206
title: Sell orders get a Packing status, and inventory added once packing has begun takes the next #
type: story
status: in-progress
priority: P2
created: 2026-10-08
reporter: jinhu
branch: dev-5
pr:
version:
related: [RS-193, RS-194, RS-204, RS-205]
---

## Ask

> when user add new inventory to the sell order. The # should append instead of reorder.

> wait, i would like add more constrain. When it is in packaging stage,

(Asked which constraint, he chose: "Append only once packing starts". Until any
line is touched in Pack mode, adding re-sorts every # as today. Once packing
has started, new products get the next # at the end.)

> add one more status for the sell order.
> [screenshot: the ORDER STATUS stepper — Draft → Shipped → Awaiting payment → Done]
>
> When user enter the pack mode. it will enter the packing status

> But in the spreadsheet. It should still order by what we have right now. Just the # keep pending.

## Context

Since v1.220.3 (RS-193) a sell order's # is one per product. It is derived on
every read by `numberSheetLines` (`routes/sellOrders.ts`), which walks the
packing list: warehouse tab → category → device → DDR generation →
brand / capacity / speed. That keeps the page, Pack mode and both packing
lists in agreement.

The trouble is what happens to a product added later. It lands in its sorted
place, and every product after it is renumbered. FEATURES.md already said so,
and that was acceptable while nothing had been labelled. But the packer writes
each product's # on the items as they are counted (RS-188), and the receiver
checks the box by those labels. An addition mid-pack therefore relabels items
that are already in the box.

Sell orders had no stage for "being packed". The statuses were Draft →
Shipped → Awaiting payment → Done (plus Closed), and Pack mode
(`#/sell-orders/:id/pack`) worked on an order in any of them.

## Acceptance criteria

- [ ] A **Packing** status sits between Draft and Shipped on the stepper, the
      status tiles, the filter and every chip. It is a row in
      `sell_order_statuses` with position 1 and tone `cool`, and needs no
      evidence.
- [ ] Opening Pack mode on a Draft moves the order to Packing, with a
      `status_changed` event. Opening it on any other status changes nothing.
      If the move fails, packing still works.
- [ ] Packing → Shipped, Awaiting payment, Done, Closed and Draft are legal.
      Draft → Packing is legal. Shipped → Packing is a 409.
- [ ] Packing reserves no stock, like a Draft. Leaving it for Shipped,
      Awaiting payment or Done runs the same stock check as leaving Draft. A
      Packing order can't be archived.
- [ ] Pack mode's count write-back works on a Packing order exactly as on a
      Draft: the tick writes the qty, untick restores it, Apply works, and Mark
      shipped works.
- [ ] While an order is past Draft, a save that adds inventory gives each new
      product the next # after every existing one. No existing # moves.
      Products added in one save are numbered among themselves in
      packing-list order.
- [ ] A new lot of a product already on the order joins that product's #.
- [ ] A typed line keeps its place through a price or label edit, because the
      editor sends the row id.
- [ ] On a Draft, an added product still sorts into place, as before.
- [ ] Both packing-list spreadsheets keep today's sorted row order. An appended
      product prints in its sorted row with its later #. The order page and
      Pack mode list it last.
- [ ] Nothing renumbers on deploy: lines already on an order count as
      numbered.

## Out of scope

- **Reserving stock in Packing.** It was considered: Packing would join the
  committed set and Draft → Packing would run the stock check. It was dropped
  because entering Pack mode could then fail on a rival's claim. A rival Draft
  can still be promoted over a box being packed, which is what already happens
  to a Draft that is being packed.
- **Freezing #s against everything else.** Removing a line, a transfer to
  another warehouse, archiving a source PO, and a spec edit that re-sorts a
  product still renumber the products after it. A line that can't ship is held
  at 0 instead of removed (RS-188).
- **Moving existing Drafts that are being packed into Packing by migration.**
  They move the next time Pack mode opens.

## Notes

- **How the marker works.**
  - `sell_order_lines.append_batch` is NULL for a line numbered with the
    sorted set, and *n* for a line added by the *n*-th save that added lines
    while the order was past Draft.
  - The PATCH rewrite carries the batch over by row id, else by lot.
  - A product's tier is NULL if any of its lines is NULL, else its lowest
    batch.
  - Numbering walks tier NULL first, then each batch, and within a tier walks
    today's packing-list order.
- **Two orders.** The spreadsheets keep sheet order, while the order page and
  Pack mode list in # order. With nothing appended the two are the same.
- **Packing → Draft** is allowed, as a step back from an accidental Pack-mode
  entry. Lines added after the step back sort in again.
- Plan: `~/.claude/plans/transient-rolling-bentley.md`.
