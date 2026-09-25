---
id: RS-106
title: Manager-only PO fields are absent, not null, for purchasers
type: bug
status: in-progress
priority: P2
created: 2026-09-25
reporter: Jinhu
branch: fix/manager-only-fields-absent
pr:
version:
related: [RS-060, RS-064, RS-099]
---

## Ask

> The finalSellPrice should not show in the UI for the purchaser, But also the API.

> Manager only access item should not only show in the UI, but also in the API response as well.

## Context

The UI already hides the manager-only PO figures from purchasers and from a
manager previewing as purchaser: every render site reads the effective role
and the backend gates on `effectiveRole`. But the gate in `routes/orders.ts`
nulls the values instead of dropping the keys, so a purchaser's
`GET /api/orders/:id` still carries `finalSellPrice: null`,
`finalSoldQty: null`, `realized: null` and `sellOrders: null`, and
`GET /api/orders` carries `realized: null`. The key names alone advertise a
manager-only feature. `/api/inventory` and `/api/dashboard` already omit their
manager-only fields rather than nulling them; the PO reads are the odd ones out.

## Acceptance criteria

- [ ] `GET /api/orders/:id` as a purchaser, or as a manager previewing as purchaser, has no `finalSellPrice` or `finalSoldQty` key on any line, and no `realized` or `sellOrders` key on the order.
- [ ] `GET /api/orders` as a purchaser, or as a manager previewing as purchaser, has no `realized` key on any row.
- [ ] A manager still gets all four keys; `null` on them means "nothing sold yet", as before.
- [ ] Every frontend reader of the four keys tolerates their absence (they are already optional in `lib/types.ts`).

## Out of scope

- The archive-conflict 409 (`sellOrders` in its payload) gates on the raw role, so a manager previewing as purchaser still sees it. It is a real manager; left as is.
- No other endpoint nulls a role-gated field (audited `apps/backend/src`).

## Notes

Plan: `~/.claude/plans/crispy-inventing-moonbeam.md`.
