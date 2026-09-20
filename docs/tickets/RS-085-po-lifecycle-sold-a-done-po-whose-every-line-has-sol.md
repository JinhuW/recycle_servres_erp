---
id: RS-085
title: PO lifecycle Sold: a Done PO whose every line has sold
type: story
status: in-progress
priority: P2
created: 2026-09-20
reporter: Jinhu
branch: feat/po-sold-lifecycle
pr:
version:
related: [RS-060, RS-064, RS-080]
---

## Ask

> Think of an new statu of PO which is only accessable for manager.
> Called Sold which is meant that all item in PO has been sold.
>
> ultrathink how we can deisgn the code and integrate smoothly with our current overall structure.

Follow-ups in the same session:

> In some case, The PO has been sold, But it is not moved to Done. Then we can not call it sold.
> Only DOne can go to sold.
>
> I meant we may not pay to purchaser yet, But it has been sold.
>
> So there is two point will trigger it to sold. When a manager move it to done, It will see if all item has been sold. then it will turn into sold status. OR we mark sell order done, and the Po also in done status. It will move to Sold.

## Decisions

Answers to the design questions, chosen by the requester:

- **Automatic only.** No button and no stage jump sets it; the two triggers
  above are the only writers.
- **Purchasers see a Sold PO as Done.** The sale is the manager's book; the
  label, the filters and the activity feed are masked for non-managers (and
  for a manager previewing as a purchaser).
- **Strictly after Done.** A fully-sold PO that is still Ready to Pay stays
  there until the purchaser is paid.

## Context

A PO's lifecycle ends at Done (commission paid). Whether its goods have all
gone is only visible line by line — `order_lines.status = 'Sold'`, written when
a sell order reaching Done consumes a line's remaining qty — or through the
manager-only Realized block's sold meter. Nothing at the PO level says "paid
*and* sold out", so a manager looking for closed books scans the Done list for
the meter.

`sold` becomes a sixth `orders.lifecycle` value with one invariant: the PO is
Done, has at least one line, and no line is anything but `Sold`. One helper
settles it inside the two transactions that can make the invariant true. In
both shells Sold shares Done's step in the stepper (it is not a stage anyone
drives) and shows as its own chip in the manager's lists. Dashboard, leaderboard
and contributions treat it exactly like Done.

## Acceptance criteria

- [x] A sell order marked Done that consumes the last unsold line of a PO
      already at Done moves that PO to Sold in the same transaction; a partial
      sale, or a PO at Ready to Pay, does not.
- [x] A manager marking a PO Done whose every line is already Sold lands it on
      Sold in one step; the response and the activity log show both moves.
- [x] `toStage: sold` is refused; a Sold PO can be reopened to Reviewing or
      Ready to Pay and re-settles on the way back to Done.
- [x] Managers see **Sold** in the PO list (desktop rail chip, phone chip
      scroller, hidden with Done by default) and on the PO page (last step
      reads Sold, a "Sold out" panel); purchasers see the same PO as Done
      everywhere, including `?status=Done` and the activity feed.
- [x] Dashboard cost/commission windows and the leaderboard count a Sold PO as
      they count a Done one.
- [x] Existing Done POs whose lines have all sold are backfilled to Sold with
      an activity row.

## Out of scope

A notification on sell-through; a Sold evidence dialog; Sold as a stage a
manager can pick.

## Notes

Plan: `~/.claude/plans/noble-humming-hoare.md` (session plan). Version
1.164.0, migration 0130. Ticket, migration and version were each renumbered
once at branch time: RS-084 / 0129 / 1.163.0 landed on `dev` (PR #378) while
this was being designed.
