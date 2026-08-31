---
id: RS-004
title: Inventory export and screens read in the vendor bid-sheet order
type: story
status: in-review
priority: P2
created: 2026-08-31
reporter: Jinhu
branch: session/20260831-125858
pr: 227
version: 1.113.0
related: []
---

## Ask

> When we export the inventory from the page, it should also sorted by the same
> order that we designed in the sells order price bid template

Then, told that the file and the on-screen list would no longer agree:

> yes. update the screen also sort

## Context

The vendor bid sheet has shipped its rows in a deliberate order since v1.51.2 —
brand, then capacity, speed, numerically collated so 8GB sits below 128GB, blanks
last, Item as the tie-break. The bid tabs and the per-warehouse packing tabs both
use it, so a picker and a bidder find a product in the same place.

The Inventory export did not: `GET /api/inventory/export` wrote rows in
`created_at DESC`. A manager comparing a bid sheet against an export of the same
stock was reading two different sequences. That half shipped first, as v1.107.0.

The screens then disagreed with the file they download, which is what the second
half of the ask is about. A workbook gets category grouping free from its tabs;
the screens are one flat table, so ranking by category has to be explicit there.
Asked which he wanted, Jinhu chose category-first (RAM → SSD → HDD → Other, brand
-grouped inside each) over a pure brand sort with categories interleaved, and
chose to change the phone list as well as the desktop table.

## Acceptance criteria

- [x] The Inventory export's rows, on every category tab, are ordered by brand,
      then capacity, then speed — the same rule and the same collation as the
      sell-order price template (v1.107.0).
- [x] The desktop Inventory table reads category rank first, then brand,
      capacity, speed.
- [x] The phone inventory list reads the same way.
- [x] Which rows appear is unchanged: both lists still take the newest 200 from
      the database, and only their arrangement changes.
- [x] A freshly submitted line is still reachable on the phone.
- [x] One implementation of the order serves the workbooks and both screens.

## Out of scope

The PO spreadsheet keeps its own line sequence — its rows follow the order's line
positions, which is what a receiver checks against.

Pushing the sort into SQL. Both list routes cap by recency in the query; sorting
there would swap the newest 200 for the alphabetically-first 200 and hide
everything recent.

## Notes

The phone list rendered `items.slice(0, 30)` with no paging. Under the new order
that window is RAM-only, and a line you just submitted would never appear in it,
so the slice was dropped — Jinhu's call when the trade-off was put to him. The
route's 200-row cap still bounds the list.

Three existing tests were quietly leaning on newest-first, or on a lucky lot
size. The seed randomises brands and quantities, so these were latent flakes
rather than new breakage: two picked "the line I just created" by position, and
two asked `freeSellableLine` for one unit before committing two — a line's last
unit flips it to `Sold` and leaves qty alone, since `order_lines` carries
`CHECK (qty > 0)`.
