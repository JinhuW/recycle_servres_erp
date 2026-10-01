---
id: RS-128
title: Box check button and page read Review mode
type: chore
status: in-review
priority: P3
created: 2026-10-01
reporter: Jinhu
branch: feat/review-mode-label
pr:
version:
related: []
---

## Ask

> call this review mode instead of "check box"

(Screenshot: the green **Check box** button in the desktop PO page header.)

## Context

RS-124 added the box-check page, which a manager opens from the PO header.
Jinhu wants it called Review mode. Asked during planning, Jinhu chose to rename
the page title as well, so the button and the page match, and confirmed the
Chinese text 审核模式.

## Acceptance criteria

- [x] The PO page header button reads "Review mode" (zh 审核模式).
- [x] The page that button opens is titled "Review mode" (zh 审核模式).

## Out of scope

The tooltip, the activity-log "Box check found n problem(s)" line, the code
identifiers, and the `/check` route are unchanged.
