---
id: RS-347
title: Review mode prices the PO from a dropped sell order sheet
type: story
status: in-progress
priority: P2
created: 2026-10-22
reporter: jinhu
branch: JinhuW/coney
pr:
version:
related: [RS-323, RS-324, RS-232, RS-301]
---

## Ask

> for the review mode. I hope we can drop an sell order spreadsheet and it can fill all the product in the PO by mtach the partnumber.
>
> /frontend-design:frontend-design Pls design the UI for operate this price fill by sell order spreadsheet.

> it should also support currency convert.

> [Image #1]
> This file drop UI can re-use some existing UI components

> lgtm, But i hope price fill is only part of the functionality. So do not take too many space of this review mode.

> lgtm. start the implementation

> I did create an featyre to fill the sell price from the sell order spreadsheet, but seem it is not available yet

## Context

The first five lines were said on 2026-10-19/20, in a session that designed
the feature on a canvas (four boards: the drop, the preview on the rows, the
applied state, every state of the Sell / Unit cell), trimmed it to one strip
on request, swapped its drop panel for the existing `AttachmentDropzone` on
the screenshot's cue, and was told to build it. That session stopped while
planning, so nothing was built. The last line, on 2026-10-22, is the
requester finding it missing.

It goes back to RS-323's ask, "I think we can drop our sell order spreadsheet
and it will auto fill the sell price". RS-324 read *drop* as *remove* and
deleted the sell order's vendor price import in v1.297.0. *Drop* meant
drag-and-drop: the sheet a buyer fills is where the sell prices come from,
and Review mode (`DesktopBoxCheck.tsx`, RS-323) is where the commission's
sell price is now set.

What exists and is reused:

- `services/priceSheet.ts` `readPriceSheetRows` — the sheet reader RS-324
  kept for the Market page: Part Number and Unit Price found by header, a
  row's currency read from its cell, number format, column header or tab.
- `lib/fx.ts` — the FX ledger's latest CNY rate, as the Market import
  converts with (RS-301).
- `PATCH /api/inventory/:lineId { sellPrice }` — the write a typed Review
  mode price takes, audited as `priced`.
- `AttachmentDropzone`, `CurrencyPicker`, `lib/priceFilePrecheck.ts` — the
  Market import dialog's drop, currency switch and client-side file check.

## Acceptance criteria

- [x] `POST /api/orders/:id/price-sheet/preview` (manager only, multipart
      `file` + `currency` USD|CNY) reads the sheet and returns, per PO line:
      `matched` with the USD price, the yuan it came from and the sheet row;
      or why not — `not-in-sheet`, `no-part`, `no-price`, `invalid-price`,
      `other-currency`, `conflict` (the part listed at two prices, both
      cited). It counts sheet rows whose part is on no line, writes nothing,
      refuses an archived PO, and is exempt from the 1 MiB JSON body cap.
- [x] Matching is by canonical part number; a sheet price lands on every
      line with that part. The same price listed twice is one price.
- [x] Review mode has a **From sheet** button beside **Fill from market**,
      and the whole list card takes a dropped `.xlsx`, showing the shared
      dropzone while a file is dragged over it.
- [x] While a sheet waits, one strip in the list card's head (in place of the
      scan hint) holds the file name, a USD / CNY switch that re-reads the
      same file, the FX rate when yuan were converted, the counts (to apply,
      repriced, unchanged, kept, skipped — the skipped breakdown on hover),
      **Cancel** and **Apply n prices**. Nothing else is added to the page.
- [x] Each row shows what the sheet would do: the incoming price in blue
      with the yuan and row under it; a typed price it replaces struck
      through, with **Keep $x** to hold it; *Already at the sheet price*;
      *Not in sheet*; or the reason it cannot be matched.
- [x] The tally's **Purchaser earns** shows current → projected, its meter
      shows the incoming prices, and the Commission card shows the figures
      with the sheet applied.
- [x] Apply writes one line at a time through the inventory line PATCH;
      a toast says how many were priced and repriced and offers **Undo**,
      which puts every previous price back. The Compare card names the file
      a price came from.
- [x] Escape cancels a waiting sheet before it leaves the page; counting
      keeps working while it waits; an archived PO offers neither path.
- [x] The planner (`planSheet` in `lib/reviewPricing.ts`) and the endpoint
      are tested.

## Out of scope

- Restoring the sell order's own vendor price import. A sell order line
  starts at its lot's sell price, which this sets.
- Writing sheet prices to the Market board. The Market page's import does
  that; a buyer's quote for one PO is not a market price.
- Choosing between two prices the sheet gives one part. The row says so and
  the manager types the price.
- Remembering the last sheet currency between visits.

## Notes

- Design canvas: https://claude.ai/artifact/HYErZjYq4FCejTZbk5RGTT (boards
  1–4; board 2 is the compact strip the requester approved).
- The page decides in/repriced/unchanged against the prices it holds now, not
  the ones the server saw, so a price typed after the sheet was read is
  judged against the sheet too.
- In the tally, the two buttons stack and "n more from the sheet" takes its
  own line: side by side they crushed the meter at laptop widths.
