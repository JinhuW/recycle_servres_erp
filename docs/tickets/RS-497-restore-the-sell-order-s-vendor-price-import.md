---
id: RS-497
title: Restore the sell order's vendor price import
type: story
status: done
priority: P2
created: 2026-11-01
reporter: jinhu
branch: JinhuW/abalone
pr: 1051
version: 1.402.0
related: [RS-324, RS-323, RS-043, RS-238, RS-347]
---

## Ask

> The sell order page had a sell price auto update options, but it disappeared.
> Try to restore the feature.

## Context

The "sell price auto update" was the sell order's **Vendor price import**
card (v1.21.0, moved to the side column above Order summary in RS-238,
v1.248.3). A manager dropped the vendor's filled bid sheet (Download →
*Price template*) on the order. A preview matched its rows by part number,
and confirming filled the lines' unit prices. The save that followed recorded
the accepted prices on the Market board as `bid:<order>` events (RS-043,
v1.138.3).

RS-324 (v1.297.0, `5c71beb0`) deleted it. That session read RS-323's "I think
we can drop our sell order spreadsheet and it will auto fill the sell price"
as *remove*, when it meant *drag and drop*. RS-347 (v1.313.0) built the same
drop for the PO's Review mode, but the sell order page never got it back.

The sheet reader RS-324 kept for the Market page (`services/priceSheet.ts`,
`readPriceSheetUpload`) is reused, not forked. The page is RS-441's
always-editable sell order, with RS-447's dirty, Cancel and Save flow.

## Acceptance criteria

- [x] An unlocked sell order shows the *Vendor price import* card at the top
      of the side column, above Order summary. Done and Closed orders don't
      show it.
- [x] Dropping the filled bid sheet calls
      `POST /api/sell-orders/:id/price-import/preview`: manager only, 8 MB
      limit, 409 on Done/Closed. It matches rows by canonical part number
      with the same row statuses as before.
- [x] Confirming fills the matched lines' unit prices in the editor and makes
      the page dirty. Nothing is written until Save.
- [x] Save sends `bidParts`, and the backend records one `bid:<order>` price
      event per confirmed part. A plain price edit records nothing, and
      neither does Cancel.
- [x] The Market page's price import and Review mode's sheet fill still work.
- [x] A lot added to an order still starts at its sell price (kept from
      RS-324).

## Out of scope

Mobile, which has no sell order editor. Any change to the bid sheet download.

## Notes

Restored by reverting RS-324's code hunks onto the current tree. The matcher
became `matchPriceRows` over `readPriceSheetRows` rows, and the reader reads
the Condition column only when asked (`{ condition: true }`), so the Market
import's rows are unchanged. Verified locally on SO-4001: the preview matched
6 rows, Fill, Save, the prices persisted, and 6 `bid:SO-4001` events.
