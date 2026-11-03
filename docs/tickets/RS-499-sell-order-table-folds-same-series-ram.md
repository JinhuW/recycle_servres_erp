---
id: RS-499
title: Sell order table folds same-series RAM
type: story
status: done
priority: P2
created: 2026-11-01
reporter: jinhu
branch: JinhuW/bramble
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1053
version: 1.404.0
related: []
---

## Ask

> I hope the sell order table can also auto fold the same series ram which is using the same apporach to group by the PN number (part of them)

> Yes. #1-#3 should also fold. In future. it should group as #1 instead of #1-3.
>
> It will be great to also show the short code in teh title.

## Context

The sell order's product table lists one row per lot. Same-series RAM therefore
spreads over several rows and several #s: Samsung `M471A1K43CB1-CRC`, `…CB1-CTD`
and `…EB1-CWE` took #1, #2 and #3, and SK Hynix `HMA81GS6AFR8N-UH` from two POs
took two #4 rows.

Inventory's grouped view folds RAM by module family (`ramFamily`, v1.244.0).
That rule keeps speed and die apart, so it would not fold #1–#3. The order page
needs a looser **series** key: the part number up to the module's organisation
(Samsung `M471A1K43`, SK Hynix `HMA81GS6`, Micron through the module code
before the speed). Inventory keeps its family rule.

The # is stored per line (`sell_order_lines.product_no`, 0170) and never
renumbered. "In future" means only lines numbered after this ships take the
series' shared #.

## Acceptance criteria

- [x] `ramSeries()` reads Samsung `M471A1K43`, SK Hynix `HMA81GS6` and Micron through the module code before the speed. Anything else has no series.
- [x] The order page, in view and edit and in every grouping, folds two or more lines of one series + label + condition into one row. The row is collapsed by default, and a chevron expands it to the member rows, which keep their qty / price / remove controls.
- [x] A folded row shows:
  - its # (`#1`, or `#1–3` on an order numbered earlier)
  - the label and the distinct short codes
  - the series as `M471A1K43*`, with the member part numbers on hover
  - the shared spec chips, with a differing value joined (`2400/2666/3200MHz`)
  - the summed qty / available, the unit price or "Mixed", and the summed total
- [x] Editing the folded row's shared price sets it on every member. "Mixed" can only be edited by expanding the row.
- [x] Every RAM row's title carries its short code.
- [x] A line numbered after this ships joins its series' # in the same warehouse tab. A new order's series take one # each. Stored #s never change.
- [x] The packing list still prints one row per part number, under the shared #.

## Out of scope

- Inventory grouping and market-price identity.
- The bid sheet's short-code fold.
- Renumbering existing orders.
- Folding on the phone or in Pack mode.
- A remove control on the folded row.

## Notes

Owner chose the looser series rule over Inventory's module family (2026-11-01), so CB1-CRC / CB1-CTD / EB1-CWE fold. Packing lists print each part number under the shared #; a series split by the sheet's speed sort can print its # twice in one tab.
