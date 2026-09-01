---
id: RS-009
title: PayPal transaction ID links the PO and the payment in both directions
type: story
status: in-progress
priority: P2
created: 2026-08-31
reporter: Jinhu
branch: session/20260831-224925
pr:
version:
related: [RS-006]
---

## Ask

> when user put the transcation in here it should bidirection link them.

("here" being the PO page's **PayPal transaction** field, shown in a
screenshot.)  Then:

> in the payment page as well.

Two rules settled by follow-up.  When a manager links a transaction to a PO on
the Payments page and the PO already names a *different* transaction:

> Fill only if empty

And when a typed ID names a transaction a manager has already dealt with:

> Only free transactions

## Context

RS-006 (v1.115.0) made a company-paid PO carry its transaction ID before it can
leave Draft, on the stated promise that the ID "is what auto-link matches on".
That promise is only half kept.

`orders.paypal_txn_id` and `bank_transactions.paypal_txn_id` are related in
exactly one place — `autoLink()` in `banktx/sync.ts` — which runs inside the
bank sync loop **every six hours**.  So the link is never made when the human
makes it, in either direction:

- **PO → payment.**  The purchaser types the ID.  The matching transaction is
  already synced and sitting in the unlinked queue, but nothing links it until
  the next sync pass.  For up to six hours a manager is reading a queue whose
  answer is already in the database.
- **Payment → PO.**  The manager links a transaction on the Payments page.
  `POST /api/bank-transactions/:id/link` sets `bank_transactions.order_id` and
  never writes the ID back, so the PO's field stays blank — the PO still reads
  as unpaid, and auto-link still has nothing to match on.

The two rules exist because each direction can collide with a decision a human
already made: a purchaser's typed ID must not be silently replaced by a
manager's link, and a manager's deliberate Unlink (which leaves a
`no_auto_link` tombstone) must not be undone by someone typing an ID.

## Acceptance criteria

- [ ] Saving a PO with a PayPal transaction ID links a synced transaction
      carrying that ID immediately — no sync pass, no reload — and the PO's
      payments ledger card shows it
- [ ] That link is not automatic-badged: it records `link_auto = FALSE`, the
      same as a manager's manual link
- [ ] A transaction that is already linked to another PO, is ignored, or
      carries a `no_auto_link` tombstone is left alone by a typed ID
- [ ] A PO minted from a tracked package's screenshot scan — born with the
      OCR'd ID — links on create, not six hours later
- [ ] Linking a transaction on the Payments page fills the PO's transaction ID
      when it is empty, and the PO's activity log records the fill against the
      manager who linked
- [ ] A PO that already names a different transaction keeps its value; the
      transaction still links
- [ ] Unlinking on the Payments page does not clear the PO's field

## Out of scope

- `packages.paypal_txn_id` on a package that never became a PO.  The read-time
  matcher already looks through packages; there is no order for it to link to.
- Any change to `POST /:id/unlink` beyond leaving it alone.
- Mobile: the PO detail screen has the field but no payments ledger card, and
  gains none here.

## Notes

- Plan: `~/.claude/plans/valiant-knitting-star.md`.
- Plan review found the write point that mattered: `create-po`
  (`routes/packages.ts` → `services/orderDraft.ts`) writes
  `orders.paypal_txn_id` directly, so a PO born with the ID could never satisfy
  a "the value changed" trigger on PATCH.  The trigger dropped that condition
  and the mint got the same call.
- One pre-existing latent bug is closed on the way past: the link filter is
  per-row `order_id IS NULL`, so a free leg whose pair partner is linked
  elsewhere could split a pair across two POs — a state `POST /:id/pair`
  already refuses.  Unreachable in practice at a six-hour cadence; instant
  links make it reachable.
