---
id: RS-246
title: Sell-order bid sheet groups DDR5 RAM by spec
type: story
status: backlog
priority: P2
created: 2026-10-13
reporter: jinhu
branch: feat/ddr5-spec-bid-sheet
pr:
version:
related: [RS-245]
---

## Ask

> This type of group should also include in the spreadsheet in the sell order.

(Right after RS-245 shipped: "this type of group" is the DDR5 spec grouping
the inventory's grouped view got there — Brand + Type + Capacity + Rank +
Speed + Class, part number ignored.)

## Context

The sell order's bid sheet (`GET /api/sell-orders/:id/price-template`) is
what goes to the buyer, and it folds the order's lines into one row per
product by canonical part number and label (`bidKey` in
`services/sellOrderNumbers.ts`, v1.242.0 folded conditions together). A DDR5
buyer prices by spec, so two part numbers of the same Samsung 32GB 2Rx4 4800
RDIMM were two rows to bid on. The vendor round-trip
(`POST /:id/price-import/preview`) matches sheet rows back to the order by
the Part Number cell, so a folded row has to carry every part number it
stands for and the import has to read them all.

## Acceptance criteria

- [ ] On the bid sheet's RAM tab, DDR5 lots from inventory fold by the RS-245
      spec key: one row, qty summed, whatever their part numbers.
- [ ] That row's Part Number cell lists each distinct part number,
      comma-separated, in the order the lines are read; a row of one part
      number reads as before.
- [ ] The price import reads a comma-separated Part Number cell as one price
      for every part number in it, so a bid on the folded row prices every
      line it folds; the preview shows one line per part number.
- [ ] DDR3/DDR4 rows, hand-typed lines and the packing lists are unchanged.
- [ ] Route test for the template; parser test for the split cell.

## Out of scope

- The packing lists and the product `#`: a picker works by part number and
  the `#` is stored per product, so they keep the part|label|condition fold.
- The sell-order page's own line grouping on screen.
- The Market page's price import, which keeps one part number per row.

## Notes

- A DDR5 lot on the order with no part number folds into its spec row too;
  the import can't name it, so it stays in "left for the manager to price".
