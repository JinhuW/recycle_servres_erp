---
id: RS-024
title: Payments must show money that has not settled yet
type: story
status: in-progress
priority: P1
created: 2026-09-04
reporter: Jinhu
branch: feat/pending-payments
pr:
version:
related: [RS-018]
---

## Ask

> In the prod, I still can not see the 1L943265PH009733N in the transcation
> that appeared in the payoal
>
> — then, once the cause was found:
>
> update all code to also include pending activity as well.
> but update the UI to indicated the pending payment as well

## Context

`1L943265PH009733N` is a $20,570 PayPal payment to a seller, initiated
2026-08-20.  It does not appear in Payments, and the reason is neither a sync
failure nor Transaction Search's reporting lag: PayPal reports it as
`transaction_status: "P"`, and both providers throw away every non-settled row
at the provider boundary —
`paypal.ts` kept only `'S'`, `mercury.ts` only `'sent'`.

Both skips carried a comment claiming pending rows re-arrive through the sync's
five-day cursor overlap once they settle.  For PayPal that is true (Transaction
Search windows on *updated* date — verified against the live API), but it does
nothing for a row that is pending *now*: it is simply absent until the day it
settles, and until then a payment in flight is indistinguishable from a payment
that never happened.

Seven PayPal transactions were pending in production when this was written,
~$41k in total, the oldest from 2026-06-01.  None of them existed anywhere in
the ERP.

Decisions taken with Jinhu before building:

- **A pending payment links to its PO.**  Auto-link claims it on the exact
  txn-ID match, so a PO whose payment is in flight stops reading as unpaid.
- **Pending amounts count in the existing totals** — the row badge is what
  distinguishes them, not a separate tile.
- **Ingest every state, badged** — not only pending, but denied, reversed,
  cancelled and failed.
- **Failed and reversed stay out of the totals and out of the unlinked
  queue.**  Counting a denied payment would make the money-out figure state
  money that never left, and putting it in the queue means dismissing rows one
  by one for non-events.

## Acceptance criteria

- [ ] Pending, failed and reversed transactions from both PayPal and Mercury
      are ingested instead of dropped, normalised to one settlement vocabulary.
- [ ] A row that has not settled carries a chip in its Source cell saying which
      state it is in; a settled row is unchanged.
- [ ] A pending payment is auto-linked to a PO naming its transaction ID, and
      shows as pending on that PO's payments ledger too.
- [ ] A pending payment is never paired — automatically or by hand — until it
      settles, because its settlement leg does not exist yet.
- [ ] When a pending payment settles, the next sync clears the badge with no
      human action, and pairs it normally.
- [ ] Failed and reversed rows are absent from the unlinked queue and from every
      tile's count and amount, offer no actions, and are reachable through a new
      settlement filter.
- [ ] A linked payment that is later reversed stops counting towards its PO's
      linked total.
- [ ] The seven pending transactions already in production are ingested, not
      only ones that arrive after the deploy.

## Out of scope

- A separate Pending tile — asked, and declined in favour of counting pending
  money in the existing totals.
- Webhooks.  Settlement state arrives on the existing six-hourly sync, as
  disputes do.
- Any change to how a pending payment is treated on the mobile or vendor
  shells: Payments is desktop-only.

## Notes

**The five-day overlap is why the existing pending rows needed a cursor
rewind.**  `syncOne` asks each provider for everything since
`cursor − 5 days`, and all seven live pending rows were last touched before
that window.  Migration `0119` winds `bank_accounts.sync_cursor` back 180 days
once (the oldest pending row is ~95 days old, past the 90-day `BACKFILL_MS`
default), and `syncOne` now also reaches back to the oldest row still marked
pending on every run — otherwise a Mercury pending row, which has no `postedAt`
at all and whose window semantics are undocumented, could go stale forever.

**Mercury has six statuses, not four** — `pending, sent, cancelled, failed,
reversed, blocked`.  Missing `reversed` and `blocked` would have left them
falling to the unknown-value default.

**`/stats` did not share `openRowFrag`.**  The Unlinked tile computed its count
and amount from an inline copy of the open-row predicate, so excluding failed
rows in `match.ts` alone would have hidden them from the list while leaving
them inside the tile above it — the exact tile/list disagreement v1.114.1 fixed
for the direction lens.  `/stats` now calls the shared fragment.

**Unrelated but found while investigating:** production's PayPal app
(`APP-6DC44273JV2741608`) still mints tokens with no disputes scope, so every
dispute call 403s.  The App-feature toggle RS-018 called for was never applied
to the live app, and dispute badges have been dark in production since
v1.124.0.  Dashboard setting; no code.
