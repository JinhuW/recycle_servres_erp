---
id: RS-324
title: "Drop the sell-order vendor price import: a sell order takes the PO's sell price"
type: story
status: in-progress
priority: P2
created: 2026-10-19
reporter: jinhu
branch: review-mode-selling-price
pr:
version:
related: [RS-323, RS-236, RS-238, RS-043]
---

## Ask

> Enhance the review mode, it should not only for the package check, but also used for filling the selling price for calculating the commision fee.
>
> I think we can drop our sell order spreadsheet and it will auto fill the sell price.
>
> /frontend-design:frontend-design enhance the UIUX

The second sentence; the first shipped as RS-323 (v1.296.0).

## Context

The "sell order spreadsheet" is the vendor bid sheet's round trip (v1.21.0):
a manager downloads the bid-sheet XLSX from a sell order, the vendor fills
the Unit Price column, and the manager drops the file back on the sell
order's edit view (*Vendor price import*, `SellOrderPriceImportDialog.tsx`,
`POST /api/sell-orders/:id/price-import/preview`). Confirming filled the
edit form's prices, and the save that followed sent `bidParts` so the
backend recorded the accepted prices on the Market board as `bid:<order>`
data points (v1.138.3).

Since RS-323 the sell price is set on the PO line in Review mode, and a sell
order line already starts at its lot's sell price
(`DesktopSellOrderDraft.tsx`: `unitPrice: it.sellPrice ?? unitCost × 1.35`),
so the price a sell order needs is on file before the order exists. The
round trip's import half, its parser, its save-side bid feed and its card
go. What stays:

- the bid sheet download itself (Download menu → *Price template*) and the
  packing lists, which vendors and warehouse staff still receive;
- the Market page's price-list import (RS-232, RS-301), which shares the
  sheet reader — the reader moves to `services/priceSheet.ts`;
- `bid:<order>` price events already on file, and the Activity page's
  rendering of them.

## Acceptance criteria

- [x] The sell order edit view has no *Vendor price import* card.
- [x] `POST /api/sell-orders/:id/price-import/preview` is gone (404 through
      the catch-all), and the JSON body-limit exemption with it.
- [x] `PATCH /api/sell-orders/:id` no longer reads `bidParts`; an old bundle
      sending it is ignored, not refused.
- [x] No new `bid:<order>` price events are written. Existing ones still
      show on the Activity page.
- [x] The Market page's import still works; the shared reader's header and
      cell tests moved to `market-price-import.test.ts`.
- [x] The bid sheet and packing-list downloads are unchanged.
- [x] The dialog's own strings leave both dictionaries; the precheck strings
      the Market dialog shares stay.

## Out of scope

- Removing the bid sheet export or the packing lists.
- The Market page import.
- Changing how a sell order line's price is seeded (lot sell price, else
  cost × 1.35) — it already takes the Review mode price.

## Notes

- The `only` option of `recordSellOrderDataPoints` existed for the bid feed
  alone and goes with it; the Done-time `sale:<order>` feed is unchanged.
