---
id: RS-515
title: Phone Record entry sheet layout fixes
type: bug
status: done
priority: P2
created: 2026-11-03
reporter: Jinhu
branch: fix/phone-record-entry-layout
pr: 1071
version: 1.413.1
related: []
---

## Ask

> [screenshot of the phone's Record entry sheet]
>
> fix the ui issue

## Context

The manager's RMB Flow *Record entry* sheet on an iPhone. In the screenshot the
kind chips run past the edge with the selected *Other* cut close to it, the Date
field is wider than its column and overlaps Method, its value is centred and it
is taller than Method, the currency toggle is shorter than Amount, there is a
wider gap under Amount, Screenshots sits tight on its box, and the box says
"Click to upload or drag & drop" on a touch screen.

## Acceptance criteria

- [x] Every kind chip shows without scrolling: one row at 430 px, wrapping below that.
- [x] Date and Method each stay in their own column, at 320, 390 and 430 px.
- [x] Single-line fields and the currency toggle share one height (46 px).
- [x] No empty row under Amount until there is an amount to offer.
- [x] A touch screen reads "Tap to add a file", with no mention of dragging or clicking.
- [x] The desktop dialog keeps its copy and its chips.

## Out of scope

The earlier request for a new phone payments screen, which was set aside for
this fix and not started.

## Notes

iOS date-input rendering could not be reproduced here (no WebKit or Simulator),
so Chromium with an iPhone profile checked the layout. The date rules still need
a look on a real iPhone on inventory-dev.

The touch wording comes from a `(hover: none) and (pointer: coarse)` check in
`AttachmentDropzone`, so every dropzone on a touch device changes its headline,
not only this one.
