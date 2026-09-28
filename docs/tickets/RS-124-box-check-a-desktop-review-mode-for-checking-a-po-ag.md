---
id: RS-124
title: Box check: a desktop review mode for checking a PO against its shipping box
type: story
status: in-review
priority: P2
created: 2026-09-28
reporter: jinhu
branch: feat/po-box-check
pr:
version: 1.188.0
related: []
---

## Ask

> Design an UI UX for the review mode in desktop view only. Once the PO in the reviewing status(or any state), manager can enter a review mode. They can easy check the item in the shipping box.
>
> Some idea is that it will enter a dedicated page that it will coming with a checkbox. once checked. the item will go to the buttom.

## Context

A manager reviewing a delivered PO today compares the box against the PO page's
line table by eye, with nothing to record what was counted. The design was
approved as a prototype ("lgtm", 2026-09-28):
https://claude.ai/artifact/8tsXpvJfGzSfAmmJPf77mN

Decisions (2026-09-28): progress is saved on the server; one list per PO (lines
are not tied to a package); a short count is a flag only and never changes the
line qty.

## Acceptance criteria

- [x] A manager sees **Check box** on the desktop PO page header at every stage (primary at Reviewing); a purchaser does not.
- [x] `#/purchase-orders/<id>/check` opens a full-width page with a checklist, a tally, a scan box and a compare panel.
- [x] Checking a line sinks it below a Checked divider; Undo restores it.
- [x] A −/+ stepper records a partial count; a scan of a part number or serial counts one unit; an unknown scan can be recorded as an extra item.
- [x] Counts, flags and extras survive a reload (`order_line_checks`, `order_check_extras`).
- [x] With every line checked at Reviewing, **Approve for payment** moves the PO to Ready to Pay.
- [x] With flags or extras, **Send flags to purchaser** notifies the owner and writes a `box_check_flagged` order event; the stage does not change.
- [x] The check endpoints 403 a purchaser.

## Out of scope

Phone shell; a per-package filter; changing line qty from a count; live sync between two managers checking at once.

## Notes

Plan: `~/.claude/plans/expressive-foraging-gosling.md`.
