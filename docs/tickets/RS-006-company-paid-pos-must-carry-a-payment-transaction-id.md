---
id: RS-006
title: Company-paid POs must carry a payment transaction ID
type: story
status: in-progress
priority: P2
created: 2026-08-31
reporter: Jinhu
branch: session/20260831-125858
pr:
version:
related: []
---

## Ask

> for all company paid PO, Purchaser must link with transcaion id.

Three follow-ups settled the shape.  What "transaction id" means:

> Fill the existing txn-ID field

— the transaction-ID field the order already has, not a picker over synced
bank rows.  When it blocks:

> At submit

— a company-pay PO cannot leave Draft without one.  And which POs it governs:

> only for new PO since now.

## Context

`orders.payment` (`'company' | 'self'`) and `orders.paypal_txn_id` have existed
side by side since `0001` and `0099` respectively, with **no cross-validation
anywhere** — not on create, not on PATCH, and not in `advanceOrderTx`, which
holds every other lifecycle guard.  So a purchaser could file a company-paid PO,
move it to In Transit, and leave no record of which payment funded it.
Reconciliation then had to be done backwards, by a manager on the Payments page,
guessing from amount and date.

The field is also the key that makes reconciliation automatic: `autoLink`
(`banktx/sync.ts`) matches `bank_transactions.paypal_txn_id` against
`orders.paypal_txn_id` and links the bank row to the PO by itself.  Requiring it
at submit therefore does more than create a paper trail — the PO self-reconciles
the moment Mercury/PayPal syncs, with nobody touching it.

Two facts shaped the design:

- **The Payments page is manager-only** (`routes/bankTx.ts` guards the whole
  router), so a purchaser cannot create a `bank_transactions.order_id` link.
  A hard link would also block POs whose payment hasn't synced yet — PayPal's
  Transaction Search lags ~3h.
- **The mobile shell showed the transaction ID read-only**, so before this a
  mobile purchaser had no way to satisfy the rule at all.

"Only new POs since now" is recorded per environment: a migration stamps the
cutoff as `NOW()` into `workspace_settings`, and each environment therefore
grandfathers exactly the POs it already had when the rule reached it.

## Acceptance criteria

- [ ] A company-pay PO created after the cutoff with an empty transaction ID
      cannot leave Draft — the advance is refused with a message naming the
      missing field, and the lifecycle does not move
- [ ] The same PO advances once a transaction ID is saved
- [ ] A self-pay PO with no transaction ID advances unblocked
- [ ] A company-pay PO created *before* the cutoff advances unblocked, and
      reports `txnRequired: false`
- [ ] The rule holds for every actor: a manager stage-jump is refused too, and
      carrier movement (the system actor) leaves a blocked PO in Draft
- [ ] Both shells refuse before the round-trip, and both let a purchaser enter
      the transaction ID on the screen they advance from — including mobile,
      where the field was read-only

## Out of scope

- The create forms (`DesktopSubmit`, mobile `OrderReview`).  The field and the
  gate both live on the PO detail page, which is the screen the advance happens
  from, so the requirement is visible exactly where it is enforced.
- Linking a real synced `bank_transactions` row from the PO page — that stays
  manager-only on the Payments page.

## Notes

- Plan review caught the one design bug before it shipped: a purely client-side
  pre-flight has no way to know the cutoff, so it would have blocked the very
  pre-cutoff drafts the rule exempts.  The server therefore decides —
  `GET /api/orders/:id` returns `txnRequired` and both shells obey it.
- The guard lives in `advanceOrderTx`, not the route, so the carrier-tracking
  caller (`shipping/track.ts`) goes through it too.  That caller discards a
  non-ok outcome, as it already does for the other blockers, so a blocked PO
  quietly stays Draft until its ID is filled.
- Expect test churn: `POST /api/orders` defaults `payment` to `'company'` and
  stamps `created_at = NOW()`, so existing tests that create a PO and advance it
  now hit the guard.
