---
id: RS-518
title: Sell order fold keeps different RAM speeds apart
type: bug
status: done
priority: P2
created: 2026-11-03
reporter: jinhu
branch: JinhuW/silverside
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1075
version: 1.414.2
related: []
---

## Ask

> This is grouped by mistake.
>
> [Image #1]
>
> Let me clarify the group.
>
> It should group by the brand, capacity, rank, and the short code. (This is my common sense, you may have a better way to group them by pn number.)

## Context

The sell order table folded `M471A1K43CB1-CRC` (2400MHz) and `M471A1K43CB1-CTD`
(2666MHz) into one row. RS-499 and RS-501 built that on purpose: `sellSeriesKey`
cut the part number at the die, whatever the speed.

Brand, capacity, rank and short code alone can't split them, because both are
Samsung, 8GB, 1Rx8, CB1. Only the speed in the part number differs. Those four
fields would also merge a laptop `M471…CB1` with a desktop `M378…CB1`. So the key
adds the part number's module family (`ramFamily`, which Inventory's grouped view
already uses): it reads through the speed and ignores packaging suffixes.

## Acceptance criteria

- [x] Lines fold only when module family, label, condition, rank and short code all match.
- [x] `…CB1-CRC` and `…CB1-CTD` show as two rows. `-CTD` lots from several POs and warehouses show as one.
- [x] Differing rank or short code stays apart, with rank compared ignoring case and spacing.
- [x] A new order's CRC and CTD lots take separate #s. A new lot joins the # of its own part or family only.
- [x] A folded row names its family (`M471A1K43CB1-CTD*`) instead of the die-level series.
- [x] Stored #s never change.

## Out of scope

- Renumbering existing orders.
- Folding Kingston and other part numbers no scheme reads.
- The bid sheet's short-code fold, which already separates speed.
- Inventory grouping.
- Phone and Pack mode.

## Notes

Reverses the owner's RS-499 decision to fold across speed (2026-11-01). The owner
chose family plus their four fields on 2026-11-03, having invited a part-number
rule. `ramSeries` was deleted with its only callers.

An order numbered between v1.404.0 and this release can hold CRC and CTD under one
stored #. They now show as two rows with the same #, since labels may carry it.
