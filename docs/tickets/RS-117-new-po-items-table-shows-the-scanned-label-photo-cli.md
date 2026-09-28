---
id: RS-117
title: New PO items table shows the scanned label photo, click to zoom
type: story
status: in-review
priority: P2
created: 2026-09-26
reporter: jinhu
branch: feat/submit-line-thumbnails
pr:
version: 1.183.0
related: [RS-109, RS-116]
---

## Ask

> It should show the image we captured in this location, user can click it and it will zoom out.

(Screenshot: "Submit a new order" items table, red boxes drawn to the right of each
RAM item name.)

## Context

Scan RAM sheet (RS-109) and the single AI scan already store each stick's label crop
on R2 and put its URL on the line (`scanImageUrl`), and the Edit order page shows it as a
thumbnail. The new-PO items table never did, so the purchaser can't check a scanned row
against its photo without opening the drawer.

## Acceptance criteria

- [ ] A new-PO row whose line has a scan image or saved photo shows a 40px thumbnail to
      the right of the item name, with `+N` when there are more photos.
- [ ] Clicking the thumbnail opens the full-screen image viewer without selecting the row;
      Esc / backdrop closes it (and only it, when the drawer is open).
- [ ] A scanned row the AI couldn't fill ("Not filled") still shows its thumbnail.
- [ ] Rows with no photo look as before.

## Out of scope

Photos still queued in the drawer (not yet uploaded); a shared thumbnail component for the
Edit order and new-PO tables.
