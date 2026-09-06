---
id: RS-028
title: Group the price template's RAM tab by device type and DDR generation
type: story
status: done
priority: P2
created: 2026-09-06
reporter: Jinhu
branch: feat/price-template-grouping
pr: 280
version: 1.129.0
related: []
---

## Ask

> For the price template download, Pls also group by Desktop / laptop /Server
> DDR3 DDR4 DDR5.
>
> [screenshot: an Excel sheet with a vertically merged label column left of
> "#" — "Desktop & laptop" spanning rows 6–26, "Server" from row 27 — the
> autofilter dropdown on "#", Image to its right, header on row 5]
>
>  I meant the spread can be like this screenshot

## Context

The vendor bid sheet (`GET /api/sell-orders/:id/price-template`, built by
`apps/backend/src/lib/sellOrderPriceTemplate.ts`) ships one flat tab per
category, rows sorted brand → capacity → speed (v1.51.2, v1.107.0). Every
inventory-backed RAM line already carries `type` (Desktop / Laptop / Server)
and `generation` (DDR2..DDR5), and both already reach the builder as
`specs.type` / `specs.generation` — the sheet just doesn't use them for
layout. Jinhu's own working spreadsheet groups the rows with a merged label
column on the left; he wants the download to arrive that way.

The screenshot is the tie-breaker on one point: the outer group is
"Desktop & laptop" vs "Server", not three separate buckets.

## Acceptance criteria

- [x] RAM bid tab has two leading merged-label columns: device group
      (Desktop & laptop / Server), then DDR generation; a run of rows sharing
      a value is one merged, centred cell.
- [x] Row order: Desktop & laptop → Server; DDR3 → DDR4 → DDR5; then the
      existing brand → capacity → speed order. Rows whose type/generation is
      blank or unrecognised sink to the end of their level under a "—" label.
- [x] `#` numbering stays continuous across groups.
- [x] The autofilter starts at `#`, not at the merged columns.
- [x] `Pack - <wh>` RAM sections use the same row order (no merges), so the
      picker and the bidder still see a product in the same place.
- [x] SSD / HDD / Other tabs are unchanged.
- [x] The price import round-trip still parses the new RAM tab.

## Out of scope

- Merged labels on the packing-checklist tabs (they follow the order only).
- Changing the inventory export or inventory screens' order.
- A three-way Desktop / Laptop / Server split — the screenshot lumps the
  first two, and that won.

## Notes

- Excel refuses to sort a range that contains unequal merged cells, so the
  autofilter has to start at `#`. Two consequences are inherent to the layout
  asked for: sorting from a dropdown reorders the data columns while the
  labels stay put, and filtering out a span's first row hides its label. The
  `Gen` / `Type` spec columns stay on the tab for exactly that reason — they
  are what filtering works on.
- Plan: `~/.claude/plans/enchanted-cooking-zebra.md` (session-local).
