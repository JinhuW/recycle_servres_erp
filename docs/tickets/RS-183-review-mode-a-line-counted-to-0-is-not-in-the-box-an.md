---
id: RS-183
title: Review mode: a line counted to 0 is not in the box and is removed on Approve
type: story
status: done
priority: P2
created: 2026-10-06
reporter: jinhu
branch: dev-2
pr: "#511"
version: 1.212.0
related: [RS-124]
---

## Ask

> In the review mode.
> When we update the line to 0, then it means it does not existing.

(Screenshot: Review mode on PO-1483, lines #33 at `0 / 4` and #37 at `0 / 1`
shown amber, legend *2 partly counted*.)

Clarified in the session:
- What happens to the line → **Removed on Approve**: nothing is deleted while
  counting; Approve for payment removes those lines, then moves the PO to
  Ready to Pay.
- Does a 0 line still need its own tick → **Yes — still tick it**.

## Context

Review mode (`#/purchase-orders/<id>/check`, `DesktopBoxCheck.tsx`, v1.188.0)
starts every line at its full qty; − lowers it when units are short, and a
tick confirms the count (v1.190.0). A line lowered to 0 reads as *partly
counted*, and Approve moves the PO to Ready to Pay with that line still at its
full qty — paid for and in stock although nothing arrived. Review mode's Edit
drawer cannot remove a line, so today the manager has to leave Review mode and
delete it on the PO page.

## Acceptance criteria

- [x] An unticked line counted to 0 shows as *Not in the box* (red), counted
      in its own legend chip, not as *partly counted*.
- [x] A 0 line still needs its own tick; *Check all remaining* leaves it alone.
- [x] A ticked 0 line carries a *Not in the box* tag and is listed in Finish
      review apart from short lines.
- [x] At Reviewing, Approve reads *Remove n & approve*, removes the lines
      ticked at 0 from the PO (same `PATCH removeLineIds` the PO page uses),
      then moves the PO to Ready to Pay.
- [x] If the move fails or is cancelled after the removal, the page reloads
      without the removed lines.
- [x] When every line is at 0, Approve is disabled with an explanation.
- [x] A PO with a pinned lot price warns that removing lines does not change it.
- [x] A scan landing on a line counted 0 ticks nothing and says to raise the
      count first.

## Out of scope

- Removing 0 lines when the PO is moved from the PO page or the phone — only
  Review mode's Approve removes them.
- An atomic server-side "remove and advance": the removal logic lives inline
  in the PATCH handler; the PO page already does PATCH-then-advance.
- Changing the qty of lines checked short (1..qty−1); they stay as today.

## Notes

- Plan: `~/.claude/plans/zany-brewing-pebble.md`.
- The state is called `absent` in code — `BOX_CHECK_REASONS` already has a
  `'missing'` flag reason.
- **Superseded in part by RS-184 (v1.213.0):** Approve now sets the lines
  ticked at 0 to qty 0 instead of removing them, because removing renumbers
  the PO. The *Not in the box* state and its tick are unchanged. v1.212.0's
  removal never reached prod.
