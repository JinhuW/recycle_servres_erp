---
id: RS-031
title: Only the warehouse manager moves a PO into Reviewing
type: story
status: in-review
priority: P2
created: 2026-09-07
reporter: Jinhu
branch: feat/ready-to-pay-stage
pr:
version:
related: []
---

## Ask

> also only the warehouse manager can move from in transit to review.
> for example, if the warehouse is Boston, then only Jinhu can move to review.

## Context

Warehouses have carried a manager since migration 0021
(`warehouses.manager_user_id`, set in Settings → Warehouses), but nothing read
it for stage moves: any manager could take any PO from In Transit into
Reviewing (`services/orderAdvance.ts`). Jinhu wants the review to belong to the
person who actually sees the goods.

Decided with Jinhu: the gate covers the move into Reviewing and, because he
also asked for it (RS-032), the move into Ready to Pay — including manager
stage-jumps that pass through either. Ready to Pay → Done and every backward
move stay open to any manager. A PO with no warehouse, or a warehouse with no
usable manager, is open to any manager: a gate nobody can pass is a stuck
order, not a rule.

## Acceptance criteria

- [x] `POST /api/orders/:id/advance` into Reviewing or Ready to Pay by a
      manager who is not the PO's warehouse manager → 403 naming who can and
      the stage that was asked for.
- [x] Stage-jumps that cross a gated stage are refused the same way.
- [x] No warehouse, no manager assigned, or an assignee who is no longer an
      active manager → any manager may.
- [x] Desktop stepper and mobile advance button lock the gated step for other
      managers and say who can; the desktop lock follows the warehouse
      selected in the form, the mobile one the saved warehouse.
- [x] Purchasers unchanged (Draft → In Transit only).

## Out of scope

- Fencing the warehouse itself: any manager may still change a PO's warehouse
  before Done, so a manager could re-home a PO to an unmanaged warehouse and
  advance it. Managers are trusted; the gate guides, it does not fence.
- Notifying the warehouse manager that a PO is waiting on them.

## Notes

- The frontend reads the manager from the warehouses cache it already loads;
  the order payload did not grow. A cache that has not loaded yet leaves the
  step open — the backend still refuses.
- Seed warehouses carry no manager, which is why no existing test moved.
