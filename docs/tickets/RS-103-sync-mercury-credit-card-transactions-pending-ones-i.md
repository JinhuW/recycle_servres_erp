---
id: RS-103
title: Sync Mercury credit-card transactions, pending ones included
type: bug
status: done
priority: P2
created: 2026-09-24
reporter: jinhu
branch: feat/mercury-pending-payments
pr: "#400"
version: 1.176.0
related: []
---

## Ask

> for mercury, The current payment should should also include pending payments.

> I can see this is missing in the ERP system.

(With a Mercury screenshot: Sep 24 · Data Destruction · Pending · −$6,814.57 ·
Account: Mercury Credit · Credit Card ••6772.)

## Context

Pending Mercury rows were already ingested. The charge in the screenshot was
missing for another reason: it sits on the **Mercury Credit** (IO card)
account. The sync walked only `GET /api/v1/accounts`, which returns checking
and savings. Credit accounts are listed by a separate `GET /api/v1/credit`,
so no card charge had ever reached the Payments page, pending or posted. Since
June that is 50 posted charges, 5 failed and 1 pending.

The checking side's card payoffs ("Mercury Credit", `IO PAYMENT` /
`IO AUTOPAY`) were classified `external` and hand-ignored. With the card's own
charges ingested, they would count the same spend twice.

## Acceptance criteria

- [x] The Mercury sync fetches every active credit account from `/credit`
      through the same per-account transactions loop, pending charges
      included and badged.
- [x] A failure of `/credit` is logged and leaves the checking/savings sync
      intact.
- [x] A Mercury row whose counterparty is one of our own Mercury accounts
      (the card payoff, on either side) is a `transfer`.
- [x] The first sync after deploy backfills the card from 2026-01-01.

## Out of scope

Showing which account a row came from on the Payments page. There is no
account column today, so a card charge looks like a checking debit.

## Notes

- Plan: `~/.claude/plans/nested-shimmying-hejlsberg.md`.
- A posted card charge is `sent`, which maps to settled. This was checked
  against the live API.
- Pending payoffs become transfers as well. The `internalTransfer` kind rule
  already does this. The settled-only restriction belongs to the human-taught
  counterparty rule and mark-transfer.
