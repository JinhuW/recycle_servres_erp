---
id: RS-129
title: Review mode: line numbers, Edit instead of Flag, device type
type: story
status: in-review
priority: P2
created: 2026-10-01
reporter: Jinhu
branch: feat/review-mode-edit
pr:
version:
related: []
---

## Ask

> a few more updates:
>
> 1. This page should also show the number. #1 #2...
> 2. The flag should be edit instead of flag, manager can update the specificion.
> 3. It should show more spec in each line, for example desktop, laptop, server...

(Screenshot: the Review mode line list with the flag editor open.)

## Context

Review mode (RS-124, renamed in RS-128) let a manager flag a line and send the
problems to the purchaser. Jinhu wants the manager to fix the line instead.
Asked during planning, Jinhu chose:
- drop flags and the Send-to-purchaser step entirely, so a short count is
  just a lowered count confirmed with the tick
- for item 3, show the RAM device type (Desktop / Server / Laptop) only

## Acceptance criteria

- [x] Every row shows its PO line number (#1, #2…), the same numbering as the PO page, and stable while rows regroup.
- [x] A RAM row shows its device type chip.
- [x] The row's flag button is an Edit button (E key) that opens the PO page's line drawer. Confirm saves the line's specs.
- [x] No flag editor, Flagged group, Send button or extra-item recording remains.
- [x] A short line can be ticked, and Approve is not blocked by short lines.
- [x] Raising a line's qty through Edit clears that line's tick.

## Out of scope

Backend `/checks` endpoints and tables are unchanged. Past `box_check_flagged`
events still render in the activity log. Photos are still edited on the PO page.

## Notes

Plan: `~/.claude/plans/replicated-dancing-cerf.md`.
