---
id: RS-218
title: A PO goes back to Reviewing while some of its products are shipped; only those stay locked
type: story
status: done
priority: P2
created: 2026-10-09
reporter: jinhu
branch: feat/rs218-shipped-lines-stay-locked
pr: 578
version: 1.238.0
related: []
---

## Ask

> When Sell Order not in shipped status. The PO in the sell order should still allow edit. 
>
> The change will be for example.

Asked back which behaviour was meant, the answer was **"Lock only shipped
products"**: a PO can move back to Reviewing and be edited even when some of
its products are on a Shipped or Awaiting-payment sell order; only those
products stay locked (kept at Done, not editable); products on Draft or Packing
sell orders become editable.

## Context

A Ready to Pay or Done PO is a closed book: to change it a manager moves it back
to Reviewing first.  That move was refused whenever *any* of the PO's lines sat
on a Shipped or Awaiting-payment sell order (`cascadeBlockers` in
`services/orderAdvance.ts`, since v1.138.5 — Draft sell orders stopped blocking
it then).  So one shipped product froze every other product on the PO.

On 2026-10-09 prod refused `POST /api/orders/PO-1471/advance` (18:37 UTC) and
PO-1477 (15:36, 15:42 UTC).  Both POs were Ready to Pay; a few of each one's
products were on SO-4080, shipped that morning, while the products being worked
on sat on SO-4082 (Packing) and SO-4084 / SO-4086 (Draft).

## Acceptance criteria

- [x] A manager can move a Ready to Pay or Done PO back to Reviewing while some
      of its lines are on a Shipped or Awaiting-payment sell order.  Those lines
      stay `Done`; every other unsold line goes to `Reviewing`.
- [x] A held line — `Done` on a Reviewing PO, claimed by a Shipped or
      Awaiting-payment sell order — is refused by `PATCH /api/orders/:id` when
      the edit actually changes it (409, naming the sell order to a manager).
      An unchanged echo of it is not refused.
- [x] The inventory editor refuses a qty or unit-cost change on a held line, as
      it did while the PO was Ready to Pay.
- [x] `GET /api/orders/:id` gives a manager `shippedOn: [sell order ids]` on held
      lines only; nobody else gets the key.
- [x] The desktop PO page, the line drawer, Review mode and the phone PO page
      show a held line as locked, naming the sell order; Review mode's Approve
      never zeroes one.
- [x] Moves to In Transit or Draft, the purchaser-edit revert, and removing a
      product are refused exactly as before.
- [x] Once the sell order is Done or Closed the line is no longer held and is
      editable again.

## Out of scope

- Draft and Packing sell orders still refuse a move to Draft / In Transit, the
  purchaser revert and a product removal (the "Both" option, not chosen).
- A line at `Reviewing` on a forward-path Reviewing PO that gets shipped keeps
  today's rules (editable except qty below the committed count); the lock is
  only for lines the move back left at `Done`.
- The inventory editor's spec, sell-price and status rules are unchanged.

## Notes

- "Held" is derived, not stored: PO at `reviewing` ∧ line at `Done` ∧ a
  committed claim (`committedSellStatuses()`, `sol.qty > 0`).  No migration.
- When the sell order settles (Done or Closed) a held line that is not sold out
  stays `Done` on the Reviewing PO until the PO advances again.  That is
  deliberate: the line was confirmed, and the forward cascade normalises it.
- Plan: `~/.claude/plans/pure-hopping-zebra.md`.
