---
id: RS-157
title: Review mode asks to move the PO to Reviewing; PO list opens it
type: feature
status: done
priority: P2
created: 2026-10-02
reporter: jinhu
branch: feat/review-mode-prompt
pr: "#478"
version: 1.201.0
related: [RS-124]
---

## Ask

> when user click the review mode. it will ask user if move the PO to review status.

> add a button here :
> [Image #1: the desktop PO list, a red box in the Actions column just left of
> the download button]
>
>  to enter the review mode directly

## Context

Review mode (the box check, `#/purchase-orders/<id>/check`) is the manager's
bench view for counting a PO against the box that arrived. Its Approve, which
moves the PO to Ready to Pay, is only offered at Reviewing. A manager who
opened it on an In Transit PO had to leave, change the stage on the PO page,
save, and open it again. The only way in was the button in the PO page header.

Decided with the requester:
- Only POs before Reviewing (Draft, In Transit) are asked. Ready to Pay, Done
  and Sold open straight away as a recount, so a closed book is never reopened
  by accident. Archived POs open straight away too, because they can't move.
- Answering no still opens review mode, at the current stage.

## Acceptance criteria

- [ ] Clicking Review mode on a Draft or In Transit PO asks "Move PO-n to
      Reviewing?" with three choices: Move to Reviewing, Open without moving,
      and Cancel.
- [ ] Move to Reviewing moves the PO to Reviewing, then opens review mode, and
      Approve is offered there.
- [ ] Open without moving opens review mode and leaves the stage alone. Cancel,
      Escape and a backdrop click do nothing.
- [ ] Reviewing, Ready to Pay, Done, Sold and archived POs open review mode with
      no prompt.
- [ ] The move re-reads the PO first. If it's no longer at the stage the prompt
      named, nothing moves on that answer. A PO now past Reviewing just opens,
      and one at the other pre-Reviewing stage is asked again.
- [ ] Each row of the desktop PO list has a Review mode button left of the
      download button, for managers only. It hides in purchaser preview. It
      behaves like the PO page button, and clicking it doesn't toggle the row.
- [ ] A move the server refuses (proof rules leaving Draft, lines out on a
      transfer) shows the server's message and stays on the page.

## Out of scope

- Phone shell: review mode is desktop only.
- Where leaving review mode goes. It still returns to the PO page, even when
  review mode was opened from the list.

## Notes

Plan: `~/.claude/plans/synchronous-rolling-popcorn.md`.

The prompt is asked *before* navigating, not on the check page. The check page
remounts after every line edit, so asking there would ask again on each save.
