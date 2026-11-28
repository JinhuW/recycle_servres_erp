---
id: RS-620
title: Home: remind managers to add cash flow for their unbacked payments
type: feature
status: done
priority: P2
created: 2026-11-28
reporter: jinhu
branch: feat/home-unbacked-payments
pr:
version: 1.486.0
related: [RS-618, RS-619]
---

## Ask

> Pls only note the manager only.
>
> also in the homepage. Create an reminder that manager should add the cash flow for it

## Context

RS-619 put a ? on PO-list payment chips that name a person with nothing in
the books behind them. That included a purchaser who paid their own PO,
whose money never enters the RMB Flow.

## Acceptance criteria

- [x] The PO list's ? flags a cost only when its Paid by is a manager, not
      the PO's purchaser.
- [x] A manager's Home lists the manager-paid costs and commissions with no
      cash flow, theirs first, each opening Accounting on that PO and kind.
- [x] A *Cash flow to add* tile counts them; the phone Home has a row.
- [x] A purchaser's Home carries none of it.

## Out of scope

Notifications or Actions cards for these payments.
