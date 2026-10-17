---
id: RS-278
title: Linked payments show the PO owner in the Owner column
type: bug
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: fix/linked-payment-owner
pr: 701
version: 1.275.2
related: []
---

## Ask

> For linked payment, the owner should be the PO owner.

(With a screenshot of Payments → All: `PO-1507`, a linked $800 payment to Erin
Murphy, shows "—" under Owner.)

## Context

The Payments Owner column (v1.121.0) reads only `bank_transactions.assignee_id`.
Migration 0116's CHECK makes an assignee and a PO link mutually exclusive, and
linking clears the assignee, so every linked row showed a dash, which was
documented as "by design". The PO already names its owner (`orders.user_id`),
and that person is who the money belongs to.

## Acceptance criteria

- [x] A payment linked to a PO (cost or commission) shows the PO owner's avatar
      and first name in the Owner column.
- [x] The owner filter set to a member also returns payments linked to that
      member's POs; "Unassigned" excludes them.
- [x] Manual assignment is unchanged: still only on unlinked rows, same
      assign/unassign controls.

## Out of scope

- Sell-order links: a sell order has no owner column.
- Changing the 0116 constraint or how assignment is stored. The PO owner is
  derived at read time, never written into `assignee_id`.

## Notes

- The API's `assignee` field now means "owner": the manual assignee, else the
  linked PO's owner. Frontend paths that act on assignment (Unassign, the
  owner-gated suggestion pool) only render for unlinked rows, so they never see
  the derived value.
