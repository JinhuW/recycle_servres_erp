---
id: RS-194
title: Fix the dev to main review findings before the v1.221 release
type: bug
status: in-progress
priority: P1
created: 2026-10-08
reporter: jinhu
branch: dev-9
pr:
version:
related: [RS-193, RS-188, RS-192]
---

## Ask

> /code-review max dev to main, fix all isue discovered and release to main

## Context

`/code-review max` of dev against main (v1.220.3 against v1.220.2) confirmed
fifteen findings. Most come from RS-193 (v1.220.3): a product's # is its
place in the packing list, but which line spoke for a product depended on the
stored `position`, and saves had started rewriting `position` in packing-list
order — so a price edit or a set-to-0 could renumber products whose items
were already labelled.

| # | Finding | Where |
|---|---|---|
| 1 | A product's specs (and so its place and #) came from its first line by `position`; a save rewrote positions, so a price edit or a set-to-0 could make another lot speak for it and renumber products | `foldSheetLines` |
| 2 | A line held at 0 that came first supplied its product's health, image and part on the bid sheet and both packing lists | `foldSheetLines` |
| 3 | By-PO tabs re-sorted their own subset, so `#2` could print above `#1`, with another Type than the plain tab for the same # | `foldSheetLines`, `renderWarehouseSheet` |
| 4 | Pack ticks on two same-text typed lines in different warehouses swapped when a save reordered them | `sellOrderPack.ts` `keyedLines` |
| 5 | The "saving moves no #" test could not catch #1 — one lot per product, all one type | `sell-order-line-numbers.test.ts` |
| 6 | By warehouse cards grouped on the warehouse a line was saved with; # follows the lot's current warehouse | `lib/sellOrderLineGroups.ts` |
| 7 | The editor's per-product price key used the raw part spelling, so two lines sharing a # could price apart | `DesktopSellOrders.tsx` `productKey` |
| 8 | A desktop/iPad tab left open on an old bundle numbers lines by index against the new API, and nothing tells it to reload | frontend |
| 9 | A product from 27+ PO lines in one warehouse got a row taller than Excel's 409pt limit, hiding sources | `renderWarehouseSheet` |
| 10 | The "tied positions" test used three distinct labels, so the tie-break it guards never decided anything | `sell-order-zero-qty.test.ts` |
| 11 | FEATURES.md (and a patch.ts comment, a test title) still described pre-1.220.3 behaviour | docs |
| 12 | `sellLineOrder`'s comment said it is the # | `lib/poLineNo.ts` |
| 13 | GET's 28-field hand mapping into the fold was untyped, so a typo or a swapped warehouse compiled and renumbered the page only | `routes/sellOrders.ts` |
| 14 | GET now sorts on every read with a fresh ICU collator per comparison | `categoryColumns.ts`, `sortSources` |
| 15 | RS-193 was a feature shipped as a patch bump (1.220.3) | `package.json` |

## Acceptance criteria

- [ ] A product's # depends only on the order's set of lines: saving the order
      as shown, editing a price, or setting a line to 0 moves no #, also when
      a product's lots differ in type and the higher-PO lot was picked first.
- [ ] The files show a product's per-lot details (health, image, part) from
      its first line above 0; its sort fields from the line that numbers it.
- [ ] Every by-PO tab lists its rows in # order, with the same group labels
      as the plain tab.
- [ ] Two same-text typed lines in different warehouses keep their pack ticks
      across a save that reorders them.
- [ ] By warehouse cards group on where the lot is now.
- [ ] Two lines sharing a # price together even when their part spellings
      differ.
- [ ] A desktop tab on an old bundle is offered a reload once a new build is
      live.
- [ ] No packing-list row is taller than Excel's limit.
- [ ] FEATURES.md, comments and test titles match the code.
- [ ] Released to main as v1.221.0; prod reports it.

## Out of scope

- Archiving a PO with "remove from sell orders" still deletes the sell lines
  above 0, which renumbers that order (known since RS-192).
- The editor's price key still reads the line's label snapshot, not the lot's
  live label (finding 7 is closed for part spellings, which is the case seen).

## Notes

Plan: two reviewed drafts in the session scratchpad. The review's own
cleanup list (duplicate comparators, re-sorting numbered products,
`noByProduct`) is folded in where the fixes touch it.
