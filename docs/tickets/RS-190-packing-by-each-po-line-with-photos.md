---
id: RS-190
title: Packing by each PO line, with photos
type: story
status: done
priority: P2
created: 2026-10-07
reporter: jinhu
branch: feat/pack-by-po-line-photos
pr: "#525"
version: 1.220.0
related: [RS-186, RS-187, RS-188]
---

## Ask

> Think of optimize the UI UX ,
> One product may comes from different PO. I hope it can check by each PO.

> The inventory style maybe a good reference. Include the Photos.

Answers to the scoping questions:

> Where should "check by each PO, with photos" go? — **Both** (the packing-list
> spreadsheet inventory-style, and photos on Pack mode's lines keeping # order)

> How should photos appear in the spreadsheet? — **Embedded thumbnail**

## Context

RS-186 (v1.216.0) gave a per-warehouse packing-list row a `From PO` cell that
stacks every PO line a product folds, but the row still had one tick box, so a
picker pulling the same part from three PO boxes couldn't tick them apart. The
inventory page already shows the shape that fits: a product row with its lots
under it, one per PO, each with a photo. Pack mode (RS-187/188) ticks each sell
order line on its own but shows no photo.

This reverses RS-186's non-goal "splitting a folded row per PO line (offered,
not picked)": the PO lines nest under their product rather than replacing it.

## Acceptance criteria

- [x] On both packing-list downloads, a product that folds two or more source
      PO lines gets a bold product row (Part #, specs, total qty, the POs it
      spans, no tick box), then one row per PO line with its sell-order #, a
      tick box, its photo, `From PO-999 #12` (`No PO` for a typed share; the
      line # on a by-PO tab) and its qty.
- [x] A product from one PO line stays one row, now with its photo.
- [x] Photos are embedded thumbnails of the lot's label scan; a lot without a
      real scan, or one that can't be fetched in time, leaves the cell blank
      and the download still succeeds.
- [x] The RAM Device/Generation labels span a product's PO-line rows;
      subtotals and totals are unchanged.
- [x] Pack mode shows each line's photo between its tag and the item; tapping
      it zooms, Esc closes the zoom before leaving Pack mode, a typed line
      shows an empty placeholder, and lines stay in # order.
- [x] The download buttons are disabled while a download is being prepared.

## Out of scope

- The bid sheet (price template): keeps its Image URL links.
- Grouping Pack mode by product or PO — RS-188 keeps it in # order.
- A thumbnail variant of stored scans; Pack mode loads the scan itself, lazily.

## Notes

Plan: `~/.claude/plans/velvet-sleeping-acorn.md`.
