---
id: RS-018
title: PayPal disputes on the Payments page
type: story
status: in-progress
priority: P2
created: 2026-09-03
reporter: Jinhu
branch: session/20260903-151545
pr:
version:
related: []
---

## Ask

> Does paypla has an apporach to query all transcation in dispute?
>
> create a new filter in the payment page to see all disputes. i meant the case
> we submitted.
> also have a red label pn the transcations. when i click the transcation, it
> will show the full process status.
>
> — and, asked which disputes: "I meant we are purchaser and we claim our money
> back."

## Context

We buy hardware through PayPal, and when a seller doesn't deliver we open a case
to claim the money back.  That case has lived entirely in the PayPal web UI: the
Payments page showed the outgoing payment as an ordinary row with nothing to say
the money was being fought over.  A manager reconciling the queue would link a
disputed payment to its PO and move on, never learning the money might come back
— or that a response deadline was running.

The Payments sync already talks to PayPal, but only to Transaction Search
(`/v1/reporting/transactions`).  Disputes are a second API on the same
credentials (`/v1/customer/disputes`) behind a separate app permission.

Decisions taken with Jinhu before building:

- **Only cases we filed as the purchaser** — money out, claimed back.  Disputes
  filed *against* us are a different thing and are not what was asked for.
- **Polled on the existing six-hourly bank sync**, not webhooks.
- **Status timeline only** on the click-through — no message threads, no
  evidence.
- **Red label on Payments rows only** — the linked PO page is untouched.

## Acceptance criteria

- [ ] The Payments page has a Disputes tile and a filter toggle; turning it on
      lists only money-out transactions carrying a PayPal dispute.
- [ ] A disputed transaction carries a red chip in its Source cell — muted once
      the case is resolved.
- [ ] Expanding a disputed transaction shows the case's stage (inquiry →
      chargeback → pre-arbitration → arbitration), its status, reason, amount,
      outcome, response deadline, and a dated timeline of what has happened.
- [ ] Disputes arrive on the existing sync; a disputes failure does not take the
      transaction sync down with it, and is visible on the page rather than
      silent.
- [ ] A dispute on a transaction we haven't ingested yet is not an error.

## Out of scope

- Responding to a case from inside the ERP (accept an offer, escalate, upload
  evidence).  Read-only for now.
- Webhooks (`CUSTOMER.DISPUTE.*`) — polling first, as agreed.
- Disputes filed against us as a seller.  They are stored if PayPal returns
  them, but the page does not show them.
- Any badge on the purchase-order page.

## Notes

**The live PayPal app did not have Disputes enabled.**  Probed before building:
the client-credentials token carried only
`https://uri.paypal.com/services/reporting/search/read`, and
`GET /v1/customer/disputes` returned `403 NOT_AUTHORIZED`.  Fixed by ticking
*Disputes* under App feature options on the live app at developer.paypal.com —
no new keys, no redeploy, the next minted token carries the scope.

Disputes are stored as a `dispute` JSONB column on `bank_transactions` rather
than a table of their own.  A transaction can carry more than one case (a PayPal
claim and a card chargeback), and a join that multiplies rows would break the
keyset-paged feed; it would also badge the Mercury settlement leg, which carries
the same `paypal_txn_id`.  Writing the column on the PayPal row only makes both
problems not exist.

"Cases we filed" needs no stored flag: PayPal's API has no `filed_by` field, but
a transaction's sign is its direction in this codebase, so a case we filed as
purchaser is always a dispute on a money-out row.
