---
id: RS-030
title: Let the PO owner picker offer managers as well as purchasers
type: story
status: in-progress
priority: P2
created: 2026-09-07
reporter: Jinhu
branch: feat/po-owner-any-member
pr:
version:
related: []
---

## Ask

> The purchaser in the dropdown selectuion can also include manager.
>
> [screenshot: the PO edit page, Order details row — Warehouse "BOSTON - MA",
> Payment Company / Self-paid, Commission rate 0, and the "Purchaser" select
> showing "Jinhu", outlined in red]
>
> only manger can move the status after "in transit".

## Context

`resolveOrderOwner` (`apps/backend/src/routes/orders.ts`) accepted only an
active purchaser as `onBehalfOfUserId` — for `POST /api/orders`,
`POST /api/orders/draft` and `PATCH /api/orders/:id` alike — and both desktop
pickers (the owner select on the edit page, v1.84.0, and the on-behalf select
on Submit, v1.82.0) filtered `/api/members` down to purchasers. Managers file
and own POs themselves, so there was never a reason the owner had to be a
purchaser; the members list has exactly two roles, so "include managers"
means "any active member".

The second sentence restates an existing rule rather than asking for a new
one: stage moves past In Transit are manager-only (`services/orderAdvance.ts`),
and that is decided by the actor's role, never by who owns the PO. It is kept
as a constraint with a test.

## Acceptance criteria

- [x] Edit page: the Purchaser select lists every active member — purchasers
      first, then managers, the `/api/members` order — not just purchasers.
- [x] Submit page: the same list, minus the signed-in manager, who is already
      the "Myself" option.
- [x] `POST /api/orders`, `POST /api/orders/draft` and `PATCH /api/orders/:id`
      accept a manager's id in `onBehalfOfUserId`; unknown, inactive and
      malformed ids still fail with 400.
- [x] A PO owned by a manager still cannot be advanced past In Transit by a
      purchaser.
- [x] `docs/FEATURES.md` cites the version.

## Out of scope

- Renaming the "Purchaser" label to "Owner" — Jinhu calls it the purchaser.
- The mobile shell, which has no owner picker.
- Letting purchasers reassign orders; that stays manager-only.
- The dashboard's per-purchaser leaderboard keeps its purchaser filter, so a
  manager-owned PO stays off it — already true for POs managers file
  themselves.

## Notes

- The warehouse-manager rule and the Ready to Pay stage that arrived in the
  same conversation are RS-031 and RS-032.
