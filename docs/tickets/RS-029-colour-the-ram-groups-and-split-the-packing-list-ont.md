---
id: RS-029
title: Colour the RAM groups and split the packing list onto its own download
type: story
status: in-progress
priority: P2
created: 2026-09-07
reporter: Jinhu
branch: feat/packing-slip-export
pr: 283
version: 1.130.0
related: [RS-028]
---

## Ask

> our latest session update the spreadsheet template. also let we use
> different light color to distinguish them.
>
> Update the pack sheet to a different download button in the sell order to
> download, But the order should be same.
>
> pls also introduce the group formate in the pack as well.

## Context

RS-028 (v1.129.0) grouped the vendor bid sheet's RAM tab with two merged label
columns — device group ("Desktop & laptop" / "Server") then DDR generation —
left of `#`. Jinhu has used it and it reads as one undifferentiated block: the
merges are there, but nothing separates one group from the next at a glance.

The same ticket left two things it now turns out he wanted. The
`Pack - <warehouse>` tabs live in the *price template workbook*, which is the
file emailed to a vendor — so the internal packing checklist rides along with
every bid request. And those tabs were given the bid tab's row order but
deliberately no labels ("out of scope" in RS-028); he wants the grouping there
too.

Clarified with him before implementation: the pack tabs **move out** of the bid
workbook rather than being duplicated; the tint covers the label cells **and**
their data rows; and each label column carries **its own palette** (device
colours on the device column, generation colours on the generation column).

## Acceptance criteria

- [x] The bid sheet's RAM tab tints each group: the device label column by
      device, the generation label column by generation, and each data row by
      a paler wash of its generation. The `Unit Price` column keeps its yellow
      fill — that fill is what tells a vendor where to type.
- [x] `GET /api/sell-orders/:id/price-template` returns category tabs only.
      No `Pack - <wh>` tab is in that workbook any more.
- [x] A new `GET /api/sell-orders/:id/packing-list` returns the
      `Pack - <wh>` tabs as their own workbook, manager-only, 404 on an
      unknown order, filename `…-packing-list-<date>.xlsx`.
- [x] The sell-order detail footer has a second download button for it,
      beside the existing bid-sheet one, with EN + ZH strings.
- [x] The pack tabs carry the same merged group labels and tints as the bid
      tab's RAM section, on the same two leading columns.
- [x] Row order is byte-identical between the two files — a picker and a
      bidder still find a product in the same place.
- [x] SSD / HDD / Other tabs are unchanged, and the price import round-trip
      still parses the bid sheet.
- [x] Uploading the *packing* workbook to the price import is rejected as
      having no price column, rather than silently matching nothing.

## Out of scope

- Widening the packing-list endpoint beyond managers. It inherits the
  price-template guard; warehouse staff get the file from a manager today, and
  changing that is a separate decision.
- Tints on SSD / HDD / Other — they have no grouping to distinguish.
- The packing list in the price-import dialog: that dialog is the bid-sheet
  round-trip and the packing file has no part in it.

## Notes

- The pack tabs get a **constant** two-column offset, not one conditional on
  the warehouse holding RAM, so two pack tabs on the same order always have
  the same layout.
- The tick box (`Packed ✓`) is deliberately left out of the row wash — a
  tinted box reads as already ticked on a printed sheet.
- Plan: `~/.claude/plans/recursive-jumping-cerf.md` (session-local).
