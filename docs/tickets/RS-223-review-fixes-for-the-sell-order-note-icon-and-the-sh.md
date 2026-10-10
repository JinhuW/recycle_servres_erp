---
id: RS-223
title: Review fixes for the sell-order note icon and the shared popover
type: bug
status: in-progress
priority: P2
created: 2026-10-10
reporter: jinhu
branch: fix/rs-222-note-hint-review
pr:
version:
related: [RS-222]
---

## Ask

> /code-review max Dev -> Prod. Fix all issue you notcied and release to prod.

## Context

A max-effort review of the dev→main release (RS-222, v1.239.0) found that
the note icon misbehaves in a few likely flows.  The worst: the note card takes
no pointer, so a click on the visible card landed on the row beneath it and
opened a *different* sell order.  That happens on an iPad (which gets the
desktop shell in landscape) and on a desktop after tabbing to the icon.

Several findings were in `useFixedPopover`, the hook the card shares with the
three Payments pickers, and were already on prod: a picker could not be closed
from its own toggle, and a short picker flipped above its row floated far from
it because it was placed by a fixed maximum height.  The list API also never
returned the customer's region, so the line under the customer name was always
blank.

## Acceptance criteria

- [x] Clicking or tapping a visible note card dismisses it without opening the
      order underneath.
- [x] Clicking or tapping the note icon toggles its card; a touch hover no
      longer holds a card open for good.  Tab still shows it, Escape closes the
      card opened last.
- [x] A Payments picker closes when its own toggle is pressed again, and a
      short picker flipped above its row sits against the row.
- [x] A popover that fits on neither side of its anchor takes the roomier side
      and is capped to it, instead of covering its own anchor.
- [x] An open popover follows its anchor through layout changes, and hides
      while the anchor is scrolled out of sight.
- [x] The sell-order list shows each customer's region under the name.
- [x] Screen readers hear the note on the icon itself.

## Out of scope

- Restyling the eight inline copies of the popover card style into one class.
- Re-attaching RS-222's missing screenshot: it was never saved anywhere that
  survives.

## Notes

The hook now measures its panel and re-places it every animation frame while
open, rather than on scroll and resize alone, so the callers no longer pass a
size.  The PO picker is anchored on its Link button rather than the whole
actions rail, because the hook now treats the anchor as part of the popover
and pressing Ignore has to close the picker.
