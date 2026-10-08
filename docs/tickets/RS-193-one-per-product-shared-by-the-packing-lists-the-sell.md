---
id: RS-193
title: "One # per product, shared by the packing lists, the sell order page and Pack mode"
type: story
status: in-review
priority: P2
created: 2026-10-07
reporter: jinhu
branch: dev-8
pr:
version:
related: [RS-188, RS-190, RS-191, RS-192]
---

## Ask

> The spreadsheet and the Sell order should share the #.
>
> The sell order should also sort same as the spreadsheet

(sent with SO-4080's BOSTON packing list, whose # column read 13, 41, 46, 47,
68, 69, 112, 129 down the DDR3 rows and then 1, 2, 3… for DDR4)

> one more things.
>
> The #1 is only for each product instead of each PO.

> Instead of the line number in the spreadsheet.

> It default by the which is listing in the spreadsheet right now

(sent with the order page's "By warehouse | By PO" toggle)

> we can put all PO in one celling, But each line for each PO in one cells

(pointing at a split product's "2 POs" cell)

The first ask came in this session, the next three in a parallel one (dev-7,
which handed the work over). Clarified:
- Line # when the order sorts like the sheet → **renumber in sheet order**
  (adding a line renumbers the ones sorted after it).
- Product # (dev-7) vs shared line # (here) → **both: one # per product,
  shared** by the page, Pack mode and the sheets.
- A product from several PO lines → **one row, its POs stacked in one cell**
  with each line's qty.

## Context

RS-188 (v1.219.0) numbered a sell order's lines by their place in the order —
one # per sell line, i.e. per PO line — and RS-190 (v1.220.0) split a product
from several PO lines into a product row plus a tickable row per PO line. The
packing lists sort products by warehouse, category, device, DDR generation and
brand/capacity/speed; the order page lists lines in the order they were added.
So the sheet's # column read out of sequence, a product from two PO lines had
two #s, and the page and the sheet listed the same lines in different orders.

## Acceptance criteria

- [x] Products are numbered 1..N in packing-list order — warehouse tabs, then
      category, device, generation, brand/capacity/speed — through the whole
      file; every sell line of a product carries its product's #.
- [x] `GET /api/sell-orders/:id` returns the lines in that order with their
      `no`; the order page, Pack mode and both packing lists show the same #s.
- [x] Both packing lists show one row per product, with one tick box; a
      product from several PO lines stacks them in its From PO / ID in PO
      cell, each with its qty.
- [x] A line held at 0 keeps its product's #; the sheet leaves its row off and
      no other # moves. An order with nothing above 0 still gets the 400.
- [x] A line added in the editor shows *new* until the order is saved.
- [x] Saving an order unchanged moves no # and writes no audit event.

## Out of scope

- Storing the numbers: they follow the lots' live specs and location, so
  adding a line, deleting a lot, a transfer or a spec edit can renumber the
  products after it (the trade-off chosen above).
- Pack mode keeps a row per sell line with its own tick.
- The bid sheet keeps its own per-tab row index in its `#` column; it is not
  this number.

## Notes

Plan: `~/.claude/plans/sparkling-snuggling-clock.md`. One pure fold
(`foldSheetLines` in routes/sellOrders.ts) feeds both the files and
`GET /:id`, which folds its own rows rather than running the sheet query a
second time, so a save landing mid-read can't leave a line unnumbered. Lines
held at 0 are folded and numbered, then dropped from the files along with any
tab or PO left empty (that keeps the "nothing to pack" 400).

Verified on a local stack (throwaway DB, Playwright, Excel → PDF): an order
whose DDR3 lot was added after its DDR4 lots and one part from two POs lists
#1 DDR3, #2 DDR4, #3 / #3 on the page, in Pack mode and on the packing list,
where the twins are one row with `PO-1290 #3 × 13` / `PO-1293 #2 × 12` in its
From PO cell; a line added in the editor reads *new*.
