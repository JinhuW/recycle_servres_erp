---
id: RS-202
title: A PO stage move on the desktop saves on the click
type: bug
status: in-progress
priority: P2
created: 2026-10-08
reporter: jinhu
branch: dev-13
pr:
version:
related: [RS-080, RS-200]
---

## Ask

> when i moved the status in the po.It should not ask them save the same status again.

> implement without asking approval. take all recommand actions.

(With a screenshot of PO-1493: stepper on Reviewing, a green *Status will
change from In Transit to Reviewing when you save* banner, the Next step card
offering *Mark as Ready to Pay*, and a footer reading *Moves to Reviewing on
save · Undo* beside a *Save · Mark as Reviewing* button.)

## Context

Since RS-080 (v1.160.0) the desktop PO page only *staged* a stage move past
Draft. `advanceTo()` in `pages/desktop/DesktopEditOrder.tsx` ended in
`setStatus(s)`, and the footer's *Save · Mark as ‹stage›* posted `/advance`.
So *Mark as Reviewing* changed nothing on the server, and the page asked for
the same move a second time. While the move was staged, the Next step card
already offered the step after it. Clicking that step then posted a
two-stage `toStage` jump, which the stepper itself never offers.

The phone (`pages/OrderDetail.tsx` `advance()`) and the desktop Draft→In
Transit hand-off already wrote their move on the click.

## Acceptance criteria

- [ ] One click on *Mark as ‹next›* (Next step card or stepper) writes the
      move for In Transit→Reviewing, Reviewing→Ready to Pay and Ready to
      Pay→Done. Done writes directly with a commission screenshot on file,
      and goes through the Done dialog without one.
- [ ] One click on *Move back to ‹stage›* in a finished stage's look-back
      writes that move.
- [ ] After a move the page reloads in place on the new stage with a toast.
- [ ] The *Status will change … when you save* banner, the *Moves to … on
      save · Undo* pill and the *Save · Mark as …* label are gone.
- [ ] Other unsaved edits on the page are saved by the same click.
- [ ] A move that is cancelled (takeover or payment-mismatch question) or
      refused (a save blocker, a server refusal) leaves the page on the
      stage the order is at.
- [ ] A move on an otherwise clean page writes no line edits.
- [ ] A move doesn't ask about lines nobody touched (incomplete legacy lines,
      duplicate part numbers).

## Out of scope

- The phone, which already writes the move on the click.
- The Draft→In Transit hand-off, which already writes on its own confirm.
- The unused `status` argument of `editLineToPatch` (the server ignores a line
  `status` on PATCH).

## Notes

- The move still runs through Save (`attemptSave` → `save` → `doSave`). That
  way the takeover question, RS-200's payment-mismatch confirm and every save
  blocker still apply. The click puts the target in `status` and a one-shot
  effect runs Save on the next render, because Save reads the move from its
  render's `status`.
- Unsaved edits are saved with the move instead of being refused with "save
  first" as on the phone. A plain desktop Save goes back to the PO list, so
  "save first" would take a manager off the PO in the middle of a review.
- Plan: `~/.claude/plans/splendid-discovering-harp.md` (reviewed by a
  subagent; its findings changed what happens to a move that doesn't go
  through, the move-only path, and the removal of the staged UI).
