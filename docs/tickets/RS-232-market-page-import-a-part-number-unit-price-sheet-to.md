---
id: RS-232
title: Market page: import a part number + unit price sheet to update market prices
type: story
status: in-review
priority: P2
created: 2026-10-11
reporter: Jinhu
branch: feat/market-price-import
pr:
version:
related: []
---

## Ask

> In the marketplace.
>
> Add an buttom to drop an spreadsheet file that has part + unit number and ignore all other info.
>
> The marketplace will update the recommand based on the market palce auto

When asked, the requester chose: the number is a **unit price** (not a
quantity); a part number not already on the Market list is **skipped and
listed**, never created; the file is **previewed first, then applied with one
click**.

## Context

The Market values page derives "Recommended max buy" from a part's recorded
price: `COALESCE(last_price, avg_sell) × (1 − target_margin)`. A manager could
only re-price one part at a time (the pencil on a row), so a broker or customer
price list meant typing every row by hand.

## Acceptance criteria

- [x] A manager sees an "Import prices" button on the desktop Market page; a
      purchaser does not, and both endpoints answer 403 for a non-manager.
- [x] Dropping an `.xlsx` reads only the Part Number and Unit Price columns
      (located by header, on any tab, below any title rows); every other
      column is ignored.
- [x] The preview lists each matched part with current → new price and
      current → new max buy, and lists every skipped row with its reason:
      not on the Market list, no price (blank or 0), invalid price, priced in
      CNY, or a duplicate (the later row wins).
- [x] Apply writes each matched price as a Market data point
      (`import:<email>`, the file name as the note); the table then shows the
      new Last sell and Max buy without a reload.
- [x] Sheets above 1 MiB (up to 8 MB) are accepted.

## Out of scope

- Creating Market rows for unknown part numbers.
- CSV and legacy `.xls` files (the bid import doesn't take them either).
- The phone Market tab.
- Converting CNY prices — such rows are skipped, not converted.

## Notes

Plan: `~/.claude/plans/toasty-juggling-wolf.md`. The sheet reader is shared
with the sell-order bid import (`services/sellOrderPriceImport.ts`).
