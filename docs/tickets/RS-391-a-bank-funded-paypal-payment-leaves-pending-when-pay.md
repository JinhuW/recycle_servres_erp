---
id: RS-391
title: A bank-funded PayPal payment leaves pending when PayPal settles it
type: bug
status: backlog
priority: P2
created: 2026-10-24
reporter: jinhu
branch: JinhuW/bowhead
pr:
version:
related: [RS-386]
---

## Ask

>> Separate problem I found, not fixed here: 10 PayPal rows don't match PayPal's latest status. Six show "pending" but have settled, including PO-1386 and PO-1411. Four were reversed in PayPal but the ERP still counts them, including PO-1383 (−$2,800) and PO-1399 (−$580), so those two POs look paid when they may not be. Fixing it changes paid totals on linked POs, so it should be its own ticket, and someone should check those two POs. The list is in the RS-386 ticket.
>
> To debug, I read the prod database and PayPal's API with the prod credentials, read-only, and deleted the scratch copies afterwards.
>
> Go ahead and debug this issue.

(The quoted part is from the RS-386 summary; the last line is the request.)

## Context

RS-386 found ten prod PayPal rows that disagree with PayPal's latest record.
A read-only debug followed: 180 days of Transaction Search in both record
modes, set against the prod rows. The ten fall into two groups with different
causes. Only one group is a sync bug.

**Stale pending: seven rows, a sync bug.** In the default
`balance_affecting_records_only=Y` mode, PayPal returns the record of the
moment money moved. For a bank-funded payment (direct debit or eCheck), that
record still says `P`. The settlement is a separate record that doesn't
affect the balance, and only the `N` history shows it (P, P, S…).

`Y` returned 8 `P` records in 180 days:

- seven have a later `S`: PO-1386 (−$500), PO-1411 (−$20,570), PO-1383
  (−$2,800) and four ignored rows;
- the eighth is a real open hold (`T1501`, ignored).

RS-386 ignores the `N` history for any transaction the balance pass returns,
so these stay `pending` forever. PO-1521's $11,950 eCheck will join them once
it clears. Pending and settled count the same in a PO's paid figure and in the
RMB accounting trigger (migrations 0199/0201), so this is the badge, the
settlement filter, and a sync window held open back to July. No money moves.

**`V` on our own payment: three rows, not a sync bug.** A `V` in the `N`
history of a payment we sent marks the reversal on the *seller's* side. Money
we get back is booked as its own credit record that references the payment
(`T1106` reversal, `T1107` refund), or it lands on Mercury for a card
chargeback.

- **PO-1399 (−$580).** We opened a "not received" case. On 2026-10-07
  PayPal debited the seller $559.27, and that is when the `V` appeared. On
  2026-10-18 the chargeback was decided against us (`DENY_BUYER`). No credit
  ever reached our account. The payment stands, so PO-1399 is paid.
- **−$150 (ignored).** The `V` came after `T1107` +143 and `T1106` +7 had
  already returned all of it.
- **−$3,100 (ignored).** An external chargeback. The seller was debited, and
  no credit reached PayPal.

Applying `V` as `reversed` would drop PO-1399's real payment, and it would
double-count wherever a credit row is linked too. It would also void RMB
entries through the accounting trigger. No `V` has ever arrived in `Y` mode
in prod, so "PayPal reverses in place", as FEATURES and the
`paypalSettleStatus` comment put it, has never been seen.

**PO-1383: a data problem, not a sync bug.** David Myers was paid $2,800
twice:

- On 2026-08-17 by direct debit (`5XB54057Y1180605W`). PO-1383 is linked to
  this payment.
- On 2026-08-20 by debit card. PO-1463 is linked to this one.

The first payment was refunded in full on 2026-08-22, through a `T1107`
+$2,800 credit after a CREDIT_NOT_PROCESSED dispute was resolved. The money
was then withdrawn to Mercury. Two things in the ERP hide this:

- That refund row was marked a transfer by hand, so nothing nets it out.
- PO-1383's PayPal leg is grouped with the Mercury card charge
  `PAYPAL *BPTBULLDOG8` from 2026-08-23. That charge belongs to the 08-20
  card payment.

So one $2,800 was paid, but PO-1383 and PO-1463 each read paid $2,800.

## Acceptance criteria

- [ ] A balance record still `P` takes the status of its latest `N` record:
      `S` → settled, `D` → failed, `V` → settled. A `V` counts as settled
      because the payment did settle, and any return is its own credit row.
      With no later record it stays pending.
- [ ] A balance record already `S` is never changed by a later `N` record.
- [ ] Read-only dry runs against prod over the sync's real windows:
  - the stale rows settle;
  - the `T1501` hold stays pending;
  - no amount, link or other status changes.

## Out of scope

- Cleaning up PO-1383 and PO-1463: the hand-marked refund and the mismatched
  group. That is for a manager to decide.
- Auto-linking a `T1106`/`T1107` credit to the PO its payment is linked to.
  It is plausible, but it is a new feature.
- The −$1,400 June row (`7HJ14630JW205391F`, ignored). It sits past both the
  120-day pending reach and the 60-day deep window, so no sync re-reads it.
  One ignored row does not justify a cursor-rewind migration.

## Notes

- RS-386 described the `Y` pass as matched by initiation date. More
  precisely, it matches by the date of the transaction's **balance record**.
  For a bank-funded payment, that is the day the money was drawn, so a
  60-day window returns PO-1411's payment (begun 08-20, drawn 08-27). The
  RS-386 guard still holds: a transaction with no balance record has nothing
  dated before it began.
- The rule lives in `currentStatus` (`banktx/paypal.ts`). The stored `raw`
  stays the record PayPal returned in the balance pass, so a row can read
  `settled` over a raw `P`. That is deliberate.
- Read-only dry runs of the new `fetchSince` against prod showed only the
  rows we meant to change: no new rows, and no other change to a held row's
  status or amount.
  - 5-day window: nothing changes.
  - From the oldest pending row in reach (07-22), which the next sync uses:
    six rows go pending → settled. They are PO-1383, PO-1386, PO-1411 and
    three ignored rows.
  - 60-day deep window: the three of those six inside it.
  - 180 days: all seven.
- After this release, the stale rows no longer hold the sync window open to
  07-22. The remaining pending row in reach is the `T1501` hold
  (2026-09-21), so the window goes back to there instead.
