---
id: RS-616
title: PayPal payments refused as transfers when linking to a PO
type: bug
status: done
priority: P1
created: 2026-11-25
reporter: jinhu
branch: fix/paired-payment-not-transfer
pr:
version: 1.482.1
related: []
---

## Ask

> debug why this payment can not link:
>
> [screenshot: "Something went wrong — A transfer cannot be linked to an order",
> POST /api/bank-transactions/ad372412-1c24-49e1-9b2d-66a477a94177/link]

> yes. go ahead and fix them

## Context

`POST /api/bank-transactions/:id/link` refuses a group with any transfer leg
(`routes/bankTx.ts`). The payment in the screenshot was PayPal `0J523557K1958812G`
(−$4,800, Nov 5, James Schlackman), paired with Mercury's `PAYPAL *JAY` debit-card
charge (Nov 7). The Mercury leg was `category = 'transfer'`.

Cause: a counterparty rule (`bank_transfer_counterparties`: mercury / `PayPal`,
taught 2026-10-24 through Mark as transfer) is re-applied on every sync to
every unlinked, settled Mercury row with that counterparty. Mercury names the
counterparty of every `PAYPAL *name` card charge "PayPal", the same as an ACH
move to our own PayPal balance, so the rule took vendor payments too. A charge
pairs while pending (the rule skips pending rows), and once it settled the next
sync turned the paired leg into a transfer, after which the pair could not be
linked. A charge that arrived already settled became a transfer before it could
pair at all.

A second shape hit the same refusal: a PayPal payment funded by an ACH pull
(`PAYPAL; PURCHASE …` / `PAYPAL; INST XFER …`), whose Mercury leg the provider
itself classifies as a transfer.

Prod on 2026-11-25: 33 unlinked payment pairs refused (24 card, 9 ACH-funded),
and 21 unpaired card charges hidden in Transfers; 69 card rows in all held the
rule's transfer category.

## Acceptance criteria

- [x] A counterparty rule, on sync and in Mark as transfer's backfill, never
      reclassifies a paired leg or a Mercury `PAYPAL *…` card charge.
- [x] `/link` judges a pair by its PayPal leg, as the list and tiles read it:
      an ACH-funded payment pair links; a pair whose PayPal leg is a transfer is
      still refused, as is a lone transfer row.
- [x] Migration 0257 returns the rule-classified card charges to external,
      leaving human verdicts and internal-transaction members alone.
- [x] The screenshot's payment links to its PO after release.

## Out of scope

- Deleting the mercury / `PayPal` rule. With card charges excluded it only
  re-states what the `PAYPAL;` descriptor already classifies; a manager can
  retract it with Unmark transfer.
- Re-categorizing the ACH-funded Mercury legs. The provider re-derives them on
  each sync, and the pair reads as its PayPal leg everywhere anyway.

## Notes

Debug note: `docs/debug-notes/2026-11-25-paypal-card-charges-taken-by-counterparty-rule.md`.
