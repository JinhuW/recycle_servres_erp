---
id: RS-349
title: Accounting: fix the period picker and backfill entries from Paid by and the payment receiver
type: bug
status: done
priority: P2
created: 2026-10-22
reporter: jinhu
branch: JinhuW/barracuda
pr: 823
version: 1.314.0
related: [RS-340, RS-328]
---

## Ask

> fix the accounting page for this UI issue:
> [Image #1]
>
> Also i hope you can backfill the data from sell order and PO page paid by.

Image #1: [assets/RS-349-period-picker.png](assets/RS-349-period-picker.png)
— the Accounting page with the period chip open: the preset list is cut off
on its left by the sidebar, and the *To* date and *Apply* run out past the
popover's right edge.

## Context

The period chip is the dashboard's `RangeChip` (`pages/desktop/DashboardRange.tsx`),
reused by Accounting since v1.310.0. Its popover is pinned `right: 0`
(`styles/desktop.css`), which suits the dashboard, where the chip sits at the
right end of the page head. On Accounting the chip is the first thing in the
scope row, so the 240px popover opens leftwards from a 230px chip, past the
page's left edge and under the sidebar. Inside it, the custom range's two date
inputs sit in a `1fr 1fr` grid: `1fr` won't shrink below an input's intrinsic
width, which is wider than half the popover, so the second column and the
full-width *Apply* overflow on both pages.

The book (`accounting_entries`, 0191) started empty on v1.310.0, but two fields
already record money that went through a manager's hands:

- a PO's **Paid by** (`orders.commission_paid_by`, 0162; the PO list's
  *Paid by* column, RS-328), the manager who paid the purchaser their
  commission;
- a sell order's **Payment receiver** (`sell_orders.payment_received_by`,
  0074), the manager who received the buyer's money.

The prod→dev copy of 2026-10-22 has 19 POs with a manager in Paid by (all
Done, Tim Wu 11, Jinhu 8) and 23 Done sell orders with a receiver (21 in CNY,
2 in USD), and no accounting entries.

## Acceptance criteria

The period picker

- [x] On Accounting the popover opens rightwards from the chip, fully on the
      page; on the dashboard it still opens leftwards from the chip.
- [x] The *From* and *To* inputs and *Apply* fit inside the popover on both
      pages.

The backfill (one migration)

- [x] Every PO with a manager in Paid by gets a **Paid · Commission** entry
      through that manager: the PO's commission in USD (the projected
      commission the Commission tab shows) at the CNY rate of its day, against
      the purchaser.
  - [x] Dated by the first sign it was paid: its first commission screenshot
        or its first move to Done, whichever came first, else the day Paid by
        was recorded.
  - [x] Skipped where the company paid: Company paid on file, or a live bank
        row linked as the commission. Also skipped where the book already has
        a commission entry for the PO, or the commission is zero.
- [x] Every **Done** sell order with a payment receiver gets a
      **Received · Sale** entry through that receiver: the order total in the
      order's currency (a USD order at the CNY rate of its day), dated the day
      it went Done, against the customer. Skipped where the book already has
      a sale entry for it, or the total is zero.
- [x] The method is the one the receipts' AI-read names agree on (Alipay,
      WeChat Pay, bank, cash), otherwise Other.
- [x] Days are China's calendar days, where the RMB book is kept.
- [x] Entries are numbered from the AC counter in book order. Each history
      reads *Backfilled from the PO's Paid by* or *Backfilled from the sell
      order's payment receiver*, with no person named.
- [x] Running the migration twice adds nothing.

## Out of scope

- The receipts' own amounts. They are the AI's reading of each screenshot:
  one receipt is often uploaded on two orders (PO-1384 and PO-1410 share a
  ¥30,359 payment), several part-payments make one sale, and a commission
  transfer sometimes carries the cost reimbursement as well. The record's own
  figure is what can be booked without double counting. A manager can correct
  an entry to the receipt.
- The PO's cost payment *Paid by* (Company card / Self-paid). It says whose
  card paid the supplier, not which manager, so there is no one to book it to.
- Sell orders that aren't Done: the money isn't in yet, or the deal didn't
  happen.

## Notes

- The receipt rename (`ai/receipt.ts`) names an upload
  `<UTC date>-<method>-<amount>.<ext>`; only the method is read back here.
- Dry run on the prod→dev copy of 10-22, rolled back: 41 entries (19
  commissions, 22 sales; SO-4050 has a zero total), and a second run adds
  none. Where a receipt covers one PO, the booked yuan lands within a few yuan
  of it: PO-1380 ¥2,377.94 against a ¥2,377 receipt, PO-1405 ¥17,895.79
  against ¥17,889 and PO-1454 ¥7,655.76 against ¥7,654. PO-1382 and PO-1445
  receipts are several times their commission, so those transfers paid more
  than the commission.
- Planned without plan mode: the request came as a `/goal` to run unattended.
  The prod write lands only with the dev → `main` release.
