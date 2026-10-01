---
id: RS-131
title: Manager can adjust sell price at Ready to Pay
type: story
status: in-progress
priority: P2
created: 2026-10-01
reporter: jinhu
branch: feat/rs131-sell-price-ready-to-pay
pr:
version:
related: []
---

## Ask

> when manager make the PO to ready to pay. the sell price should still able to adjust

## Context

From Ready to Pay on, the desktop PO page is closed-book: the line drawer opens
read-only and Save only writes notes or a stage move. Sell price is the
commission projection, so a manager correcting it during payment review is
exactly the edit that matters at that stage. The backend already accepts a
manager's `sellPrice` on a closed-book line via `PATCH /api/inventory/:id`
(only qty / unit cost are refused); the inventory line editor was the only way
to reach it.

## Acceptance criteria

- [ ] On a Ready to Pay PO, a manager (real role) opening a line on the desktop
      PO page can edit Sell / unit; every other field stays disabled.
- [ ] Save writes the changed sell prices, stays on the PO, and the commission
      projection reflects the new price.
- [ ] Purchasers, Done/Sold and archived POs stay fully locked.
- [ ] Backend test pins: manager `PATCH /api/inventory/:id {sellPrice}` at
      ready_to_pay → 200; purchaser → 403.

## Out of scope

- Done / Sold POs (commission is settled at Done).
- The phone PO page — its line editor does not open on a locked PO.
- Unit cost, qty and other line fields stay frozen.

## Notes

Plan: `~/.claude/plans/sunny-watching-parasol.md`. Relaxing `PATCH /api/orders`
`touchesFrozen` for sellPrice-only lines was rejected: `editLineToPatch` sends
every field, so it would need a per-field diff and would weaken the
closed-book guard.
