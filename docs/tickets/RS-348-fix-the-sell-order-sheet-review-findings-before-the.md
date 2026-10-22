---
id: RS-348
title: Fix the sell order sheet review findings before the v1.313 release
type: bug
status: done
priority: P2
created: 2026-10-22
reporter: jinhu
branch: JinhuW/coney
pr: 822
version: v1.313.1
related: [RS-347]
---

## Ask

> I did create an featyre to fill the sell price from the sell order spreadsheet, but seem it is not available yet

The feature (RS-347) reached `dev` as v1.313.0. Making it available means a
release to prod, and releases here go out after a high-effort review of what
they carry, with every finding fixed first (RS-345, RS-346). This ticket
holds that review's findings on PR #821.

## Context

`/code-review high 821` raised ten candidates. Seven are fixed; three are
left, with the reasons under *Out of scope*.

## Acceptance criteria

- [x] **Undo after Apply** restores only the lines still at the price the
      sheet wrote. A price typed after Apply stands. Undo waits while another
      batch of price writes runs, and a line's *Priced from* goes only when its
      restore saved.
- [x] **A sheet price can be typed over.** The incoming field is a price field
      (`p` focuses it). A different price, or a blank, is saved and held
      against the sheet, as *Keep* holds one; a line held unpriced reads *Left
      unpriced*. Before, the field was read-only and `p` then digits filtered
      the list instead.
- [x] **A dropped file can't replace a sheet that waits.** Only Cancel does,
      as with the disabled *From sheet*. A file the list won't take no longer
      falls through to the browser, which opened it in place of the page.
- [x] **"Skipped" counts parts, not rows.** The preview's `notOnPo` is the
      number of parts the sheet prices that no line carries, so a repeat or a
      blank row is not another part.
- [x] **A part priced and also listed at 0 is a conflict.** 0 means "not
      buying", so a re-listing at 0 can withdraw the bid; the row cites both
      and the manager decides. A blank cell beside a price still doesn't count.
- [x] The multipart read the Market import and the sell order sheet share
      (form, size cap, currency, workbook, columns) is one function,
      `readPriceSheetUpload` in `services/priceSheet.ts`.
- [x] The preview's two reads go through `allLimited`.

## Out of scope

- **A missing FX rate.** A yuan-marked row on a database with no `fx_rates`
  row fetches one from Frankfurter, and an outage there fails the preview.
  The Market import behaves the same, and prod's refresh loop keeps a rate on
  file.
- **Moving the preview's response types into `packages/shared`.** The Market
  import keeps its preview types on the frontend too; this follows it.
- **Memoising the plan.** It is one pass over the lines per render, beside the
  money maths that already runs on every render.

## Notes

Verified on the local stack: typing $30 over an incoming $28.47 saved $30 and
held it (*2 kept*); a second drag while the sheet waited showed no veil; and
after Apply, retyping A to $80 then Undo left A at $80 and put F back to
unpriced.
