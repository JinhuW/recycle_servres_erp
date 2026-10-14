---
id: RS-250
title: PO list: red ! mark when linked payment differs from total cost
type: story
status: done
priority: P2
created: 2026-10-14
reporter: jinhu
branch: feat/po-list-payment-gap-mark
pr:
version: 1.258.0
related: [RS-200]
---

## Ask

> when PO total cost does not match the payment amount.
>
> show a red ! circle ahead.

(With two screenshots of the desktop PO list: the Total cost / Commission /
Payment columns, where the Payment chip reads `Company | $1,600` next to a
$1,600 total, and the left edge of the same table — the expand chevron and
the `PO-1505 📎` order ids — where the mark should go.)

## Context

Since v1.225.0 a manager is warned about a payment gap — the bank's net on
the PO's linked payments against goods + fees — in Review mode and on the PO
page's Order status card, and asked *Continue anyway?* at approval. The list
shows both figures (the Total cost cell and the `Company | $…` Payment chip)
but says nothing when they disagree, so finding the off POs means reading
every row. The comparison already has one implementation,
`lib/paymentGap.ts`, which the list can call with the figures it already
loads (`linkedPaid`, `goodsTotal` / `totalCost`, `otherFees`).

## Acceptance criteria

- [x] On the desktop PO list, a company-paid PO whose linked net paid differs
      from its total cost (goods + fees, to the cent) shows a red circled `!`
      ahead of its order id.
- [x] Hovering the mark says what the bank paid, what the PO totals and the
      difference, in the same words as the PO page's banner.
- [x] A PO with nothing linked, a self-paid PO, and a PO whose figures agree
      show no mark. Purchasers never see one (they don't receive
      `linkedPaid`).
- [x] The tooltip is translated (EN / ZH).

## Out of scope

The phone PO list (the warning never shipped there). A filter or sort for
mismatched POs. Blocking anything — the mark informs, like the banner.

## Notes

Same rule as the banner, including self-paid POs being exempt: their bank
money is the purchaser's reimbursement plus commission, so it never matches by
design.
