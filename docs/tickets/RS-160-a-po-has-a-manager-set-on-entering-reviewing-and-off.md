---
id: RS-160
title: A PO has a manager, set on entering Reviewing and offered to whoever moves it next
type: story
status: done
priority: P2
created: 2026-10-03
reporter: jinhu
branch: feat/po-order-manager
pr: "#484"
version: 1.203.0
related: [RS-157]
---

## Ask

> Create a new concept for the PO. I hope the manager move the PO to review status, The PO will assign the reviewer to the manager.
>
> once it change the status to the next step, if it already have a manager and diff with the current user who move the status. it wil pop out an diagram and ask if you want to update xxx to yourself as the manager of this order?

## Context

Since v1.168.0 any manager can take any PO into Reviewing and on through Ready
to Pay and Done. Nothing on the PO records which manager is handling it. The
only trace of who moved it is in the activity log.

Every manual stage move goes through `advanceOrderTx`
(`apps/backend/src/services/orderAdvance.ts`), behind `POST
/api/orders/:id/advance` and the hand-off. It reads the order row `FOR NO KEY
UPDATE`, so the manager can be recorded atomically with the move. On the
client, the move is sent from four places:
- the desktop PO page's Save
- Review mode's *Move to Reviewing* prompt (RS-157)
- Review mode's *Approve for payment*
- the phone's next-step button

Decisions taken with the requester before planning:
- **Declining still moves.** The choices are *Make me the manager*, *Keep
  ‹X›* and *Cancel*.
- **Every manager move asks**, forward and back.
- **POs already past Reviewing are backfilled** from the activity log.
- **Everyone sees the manager**, purchasers included.

## Acceptance criteria

- [x] `orders.manager_id` exists (FK `users`, `ON DELETE SET NULL`, indexed).
- [x] A manager's move into Reviewing, Ready to Pay or Done, on a PO with no
      manager, makes that manager its manager. No dialog appears.
- [x] `/advance` accepts `takeManager: true`. From a manager, a successful
      move then sets the manager to the caller. A purchaser's flag is
      ignored, and a refused move changes nothing.
- [x] Each change writes a `manager_changed {fromUserId, from, toUserId, to}`
      order event, with `from` null on the first assignment. It shows in the
      activity log for every role.
- [x] `GET /api/orders/:id` and `GET /api/orders` return
      `manager: {id, name} | null` to every role.
- [x] Desktop and phone: when a manager moves a PO whose manager is someone
      else, a dialog asks first.
      - *Make me the manager* moves the PO and takes it over.
      - *Keep ‹X›* moves it and keeps X.
      - *Cancel* does nothing.
      - It covers four doors: the desktop page Save, Review mode's *Move to
        Reviewing*, Review mode's *Approve for payment*, and the phone's
        next-step button.
- [x] The desktop PO header and the phone Order status card show
      "Manager: ‹name›" when one is set.
- [x] The migration backfills each PO with an `advanced` → `reviewing` event
      with the actor of the latest one, provided that user is still a
      manager.

## Out of scope

- **The hand-off** (Draft → In Transit through `/handoff`) doesn't ask. It is
  the purchaser's submission door, not a review step, and the next manager
  move asks anyway.
- **The automatic Done → Sold settle** (`services/orderSold.ts`) neither
  stamps nor asks.
- **Changing the manager without a move.** There is no picker; taking over
  happens only on a move.
- **Notifying the previous manager** of a takeover.
- **Clearing the manager.** It is sticky, so a revert to Draft or a send-back
  keeps it.
- **Backfilling POs a manager jumped straight from Draft to Reviewing.** That
  jump writes a `submitted` event with no `to`, so these POs start empty. They
  fill in, without a dialog, on the next manager move to Reviewing or later.

## Notes

- Plan: `~/.claude/plans/piped-meandering-dragon.md`.
- The `manager_changed` and `advanced` events from one move share the
  transaction's `NOW()`. `/events` breaks that tie on a random UUID, so the
  two rows can appear in either order, as the hand-off's two rows already do.
