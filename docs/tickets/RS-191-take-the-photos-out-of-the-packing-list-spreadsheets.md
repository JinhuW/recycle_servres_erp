---
id: RS-191
title: Take the photos out of the packing-list spreadsheets
type: story
status: in-review
priority: P2
created: 2026-10-07
reporter: jinhu
branch: dev-7
pr:
version:
related: [RS-190]
---

## Ask

> Photos is not required in the spreadsheet. pls remove them.

## Context

RS-190 (v1.220.0) gave both packing-list downloads
(`GET /api/sell-orders/:id/packing-list`, with or without `?groupBy=po`) a
`Photo` column holding an embedded thumbnail of each lot's label scan, which
the export fetched from the scan's public URL (`lib/scanThumbnails.ts`, up to
200 photos, 20 s budget). The same release split a product from several PO
lines into a row per line and put each line's photo in Pack mode. Only the
spreadsheet photos are being dropped.

RS-190's own scoping answer was "How should photos appear in the spreadsheet?
— Embedded thumbnail"; this ask reverses that answer and nothing else.

## Acceptance criteria

- [x] Neither packing list (per warehouse, by PO) has a `Photo` column or any
      embedded image, even for a lot with a real scan.
- [x] The export makes no outbound fetch for a lot's scan.
- [x] The per-PO-line rows, `#`, tick boxes, `From PO` / `ID in PO`, RAM
      labels, subtotals and totals stay as they were in v1.220.0, with Part #
      moving back to the column right after the tick box.
- [x] The Packing list button's hint no longer mentions a photo (en + zh).

## Out of scope

- Pack mode keeps each line's photo on screen, and `GET /api/sell-orders/:id`
  keeps `imageUrl`.
- The bid sheet keeps its `Image URL` links (2026-07-22 decision); it never
  embedded images.
- The per-PO-line split layout from RS-190 stays.

## Notes

Reverses the spreadsheet half of RS-190. Plan:
`~/.claude/plans/ancient-rolling-muffin.md`.
