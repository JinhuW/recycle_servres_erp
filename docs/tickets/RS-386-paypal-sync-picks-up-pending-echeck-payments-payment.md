---
id: RS-386
title: PayPal sync picks up pending eCheck payments; Payments stops offering Link on a transfer
type: bug
status: backlog
priority: P2
created: 2026-10-24
reporter: jinhu
branch: JinhuW/bowhead
pr:
version:
related: []
---

## Ask

> [Image #1] debug it and figure out how to fix this issue

(The image: the Payments page's error dialog, "Something went wrong — A
transfer cannot be linked to an order",
`POST /api/bank-transactions/eb1c373e-d693-4f86-aa49-737b06d86e3e/link · 400`.)

## Context

The row the manager tried to link is the Mercury leg of a PayPal eCheck
payment: −$11,950.00, `PAYPAL; ECHECK; RECYCLE SERVERS LLC`, posted
2026-10-23. `mercuryTxnCategory` (`banktx/mercury.ts`) marks every `PAYPAL;`
ACH descriptor a transfer, and that is right. It is PayPal pulling the money
from Mercury. `POST /:id/link` refuses transfers on purpose, because the
PayPal leg of the same payment is the one that links.

That PayPal leg was not in the ERP. PayPal had it: `T0011` −11,950.00 to the
supplier (txn `55G24591KV2293600`), funded by a `T0300` +11,950.00, both
initiated 2026-10-22 and still **pending**. That is PO-1521. The sync asked
Transaction Search without `balance_affecting_records_only`, and PayPal
defaults it to `Y`. A pending eCheck does not touch the balance until it
clears, so PayPal left both legs out. Every pass logged
`paypal inserted=0 updated=152`, with no error. The payment would only have
appeared once the eCheck cleared, 3–6 business days later. Until then the
manager had nothing to link it with.

The rail made it worse: it offered **Link** on a transfer row, which the
server refuses every time. A transfer row already gets no PO candidate and no
grouping candidate from the server (`routes/bankTx.ts`), so that button could
only end in this error.

Over 180 days of prod, a `balance_affecting_records_only=N` query adds 7
transactions that the default leaves out:

- the two pending eCheck legs;
- three denied attempts (two direct debits and a `T1107`);
- one voided authorization (`T1302 V`);
- one hold, `T9900`, whose only record is **settled** at −$212.50. It moved no
  money.

## Acceptance criteria

- [x] A pending PayPal payment that PayPal leaves out of balance-affecting
      records (an eCheck) syncs as a `pending` row, together with its `T0300`
      funding leg.
- [x] A transaction only the `N` pass returns is taken at its latest record,
      and dropped if that record is settled. A transaction both passes return
      appears once, as the balance pass has it.
- [x] A pending eCheck that bounces later (P→D) updates its row to `failed`
      instead of staying pending forever.
- [x] A late `N` record of a transaction begun before the sync window never
      changes a row the ERP holds.
- [x] The Payments rail shows no **Link** button, and so no picker, on a
      transfer row. **Not a transfer** in the expansion is still the way out.

## Out of scope

- Reclassifying `PAYPAL; ECHECK` Mercury legs. They are transfers.
- Backfilling by hand. The first sync after the deploy pulls the legs in.
- PO-1521's `payment_method = cash`. Whether to correct it is the manager's call.
- **Held rows whose status PayPal later changed in a non-balance-affecting
  record.** Ten prod rows disagree with PayPal's latest record:
  - Six show `pending`, but PayPal settled them: four bank-funded payments plus
    PO-1386 (−$500) and PO-1411 (−$20,570).
  - Four were reversed in PayPal but still count in the ERP: two ignored rows,
    plus PO-1383 (−$2,800, held `pending`) and PO-1399 (−$580, held `settled`).

  Fixing it means letting the `N` history override what the balance pass says
  for transactions it returns, and that changes money on linked POs. It needs
  its own ticket and a manager's eye on those four.

## Notes

- How the `N` pass behaves, from prod:
  - It answers with **one record per state** a transaction went through: P,
    then D, or P, P, S, V. The balance pass returns one record per transaction.
  - It matches a record by its **update date**. The balance pass matches a
    transaction by its **initiation date**. So one transaction's records can
    land in different 31-day windows. The merge runs across the whole fetched
    range, and an `N` record counts only if its transaction began inside that
    range. Without that rule, a 5-day window would pick up a late record that
    the weekly deep window then overwrites, and the row's status would flip
    back and forth.
- Dry runs of the new fetch against prod (read-only) used three windows: 5 days,
  back to the oldest pending row, and 180 days. None changed a held row's
  status or amount. They added only the two pending eCheck legs and the four
  dead records above.
- A denied `T0300` record carries the negated amount (+20,570 becomes −20,570).
  The row takes its latest record whole. It is dead, so no total sees it.
- Each window now costs two Transaction Search calls. The sync runs every six
  hours.
