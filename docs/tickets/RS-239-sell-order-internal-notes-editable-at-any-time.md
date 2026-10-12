---
id: RS-239
title: Sell order internal notes editable at any time
type: story
status: done
priority: P2
created: 2026-10-12
reporter: jinhu
branch: feat/so-notes-anytime
pr:
version: 1.249.0
related: []
---

## Ask

> Internal notes can add at any time.

## Context

The sell order page showed Internal notes as read-only text in view mode;
only edit mode had a textarea, and `toEdit` is unavailable once the order is
Done or Closed (`locked`). `PATCH /api/sell-orders/:id` already accepts
`notes` in every status — `STRUCTURE_LOCKED_STATUSES` gates only customer,
lines and currency.

## Acceptance criteria

- [x] On the view page, Internal notes is a textarea in every status,
      Done and Closed included.
- [x] Save and Cancel appear only when the text differs from the saved notes;
      Save PATCHes `notes` alone and reloads the order and its History.
- [x] Edit mode still saves notes with the form.

## Out of scope

- The mobile shell's sell order view.
- Notes on purchase orders.
