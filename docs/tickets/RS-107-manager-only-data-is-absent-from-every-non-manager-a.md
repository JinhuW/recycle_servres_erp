---
id: RS-107
title: Manager-only data is absent from every non-manager API response
type: bug
status: done
priority: P2
created: 2026-09-25
reporter: Jinhu
branch: fix/manager-only-api-sweep
pr: "#405, #406"
version: 1.177.2
related: [RS-106, RS-060, RS-064]
---

## Ask

> Audit every manager-only view in the ERP and make sure the backend enforces it, not just the UI.

> RS-106 (v1.177.1, PR #404) found that the PO read endpoints hid manager-only
> figures in the UI but still sent the keys to purchasers as null
> (`finalSellPrice`, `finalSoldQty`, `realized`, `sellOrders`). Jinhu's rule:
> "Manager only access item should not only show in the UI, but also in the API
> response as well." A null-valued key still names a feature the caller isn't
> meant to know exists. That fix covered only `routes/orders.ts`. This task is
> the sweep across everything else.

## Context

Every manager-only surface on the desktop, the phone, the vendor portal, the
MCP tools and the exports was traced from its UI gate to the endpoint behind
it. Whole-endpoint manager features (sell orders, customers, vendor bids,
transfers, activity, members, bank and internal transactions, tracker,
coordinator, connectors, FX rates, inventory export and analysis) already 403
a non-manager. Purchaser-shared reads (orders, dashboard, inventory, packages,
suppliers, workspace) are already row-scoped or omit their manager-only keys.
Seven places still let the caller learn about a manager feature:

- `GET /api/orders` sent `linkedPaid: null` (the bank-linked total behind the
  Payments link) to non-managers.
- `GET /api/orders/:id` sent `pendingRevert: null` (the manager's change-review
  dialog) to non-managers.
- `GET /api/orders/:id/events` handed the PO owner the `archived` event's
  `removedSellOrderLines` count, and the activity log rendered it.
- `PATCH /api/orders/:id` refused a purchaser's edit with the blocking sell
  order ids in the body and in the message, where the archive refusal
  deliberately names none.
- `GET /api/dashboard` nulled `email`, `cost`, `revenue`, `profit` and
  `commission` on the leaderboard's peer rows instead of leaving them out.
- `GET /api/warehouses` nulled `managerPhone` and `managerEmail` for
  non-managers.
- `GET /api/inventory/:id/sell-orders` — the "Linked sell orders" card on the
  manager-only inventory edit page — answered the line's owner with sell order
  ids, customer names and sale prices.

"Non-manager" is `effectiveRole` for response shape, so a manager previewing
as purchaser gets the purchaser shape. Whole-endpoint 403s stay on the raw
role, as every other 403 in the codebase does (`activity.ts` says why: the
preview is a viewing convenience). The archive-conflict 409 keeps its raw-role
gate, as decided in RS-106.

## Acceptance criteria

- [x] `GET /api/orders` as a purchaser, or as a manager previewing as purchaser, has no `linkedPaid` key on any row; a manager still gets it.
- [x] `GET /api/orders/:id` as a purchaser, or in preview, has no `pendingRevert` key; a manager still gets the array.
- [x] `GET /api/orders/:id/events` as a purchaser, or in preview, has no `removedSellOrderLines` on the `archived` event; a manager still gets the count.
- [x] `PATCH /api/orders/:id` refused for a line named by a sell order carries `offendingLineIds` but no `sellOrderIds` for a purchaser or in preview, and the message names no sell order; a manager keeps both. The purchaser-edit revert refusal has no manager variant — it is always a purchaser's action.
- [x] `GET /api/dashboard` as a purchaser has `email`/`cost`/`revenue`/`profit`/`commission` on the caller's own leaderboard row only; in preview no row has them; a manager gets them on every row.
- [x] `GET /api/warehouses` as a purchaser, or in preview, has no `managerPhone`/`managerEmail` keys; a manager still gets them.
- [x] `GET /api/inventory/:id/sell-orders` returns 403 to a purchaser, including the line's owner; a manager (previewing or not) gets the list.
- [x] Purchasers still read and edit their own POs, use the market tab, the phone capture flow and their own shipping.

## Out of scope

- Switching whole-endpoint 403s to `effectiveRole`. Every existing one is
  raw-role by design; flipping them would also make the real-role FE gates
  (PO payments ledger, on-behalf picker, Settings panels) render and 403.
- Supplier spend/PO-count rollups summing every user's POs to a supplier
  the caller owns — a scoping nuance, not a manager-only view.
- Own-line `unitCost` edits and `sold {sellOrder}` ids in inventory event
  detail — reachable only through the owner-scoped inventory endpoints, whose
  UI is manager-only anyway.
- Three write paths (`revert-ack`, status-meta and line-photo writes) gate on
  `effectiveRole` against the `lib/role.ts` convention. Not a leak.

## Follow-up (v1.177.3, #406)

A `/code-review max` pass on v1.177.2, with a browser check of the purchaser,
manager and preview-manager UI, found six more items of the same kind:

- [x] `PATCH /api/orders/:id` and `POST /api/orders/:id/handoff` returned `paymentsLinked` — the bank-link count behind the manager-only Payments page — to every caller. The key is now managers-only; a purchaser who saves a matching PayPal id sees a plain "Saved" instead of "its bank payment is now linked".
- [x] The advance / hand-off refusal for sell-order-committed lines named the sell orders with no role gate. Only a manager can move a PO backwards, so this reached a previewing manager, not a purchaser; it now uses the same effective-role body as the PATCH refusal.
- [x] The manager arm of the purchaser-edit revert refusal was unreachable and is gone.
- [x] `docs/FEATURES.md` overclaimed: inventory reads scope on the real role by design. Three comments still said "null" where the key is absent.
- [x] The archived-event test now asserts `lines` survives the strip.
- [x] Warehouse POST and PATCH responses follow the same contact-key gate as the list.

Left for later (all low): sell-order and transfer ids inside inventory event
detail; the sell-order id in the "Sell order closed" notification; revert-ack
events visible to the PO owner; the millisecond cursor on the orders list
keyset (pre-existing, unrelated); a `managerOnly()` helper; fixture
duplication across the order test files.

## Notes

Plan, with the full audit table: `~/.claude/plans/bright-conjuring-robin.md`.
