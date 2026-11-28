---
id: RS-618
title: PO list: cost and commission payment chips link to Accounting
type: feature
status: done
priority: P2
created: 2026-11-27
reporter: jinhu
branch: feat/po-list-payment-chips
pr:
version: 1.484.0
related: []
---

## Ask

> I hope we can update the title more clear and add a few more field.
>
> 1. The payment could be cost payment/ commission payments to make the informtion more clear.
> 2. All payment should have a link to the accounting page.

> The cost method should integrate with the Commission for example Bank | 2000 or Paypal | 2000
> Same as paid by

> no. The cost payment may also include the Paid by. for example Jinhu | $2000. Paid by is not required.

> Commission Payment should already covered yhe Commission owed

## Context

On the desktop PO list the Commission, Paid by and Payment columns didn't say
which money they were about: Paid by was the commission's payer, Payment was
the cost's. Only bank-linked rows linked anywhere, and to Payments.

## Acceptance criteria

- [x] The list has two payment columns, **Cost payment** and **Commission
      payment**, each one chip `payer | amount`.
- [x] Cost payment's amount is the bank-linked total ($) or, without one, the
      cost booked in Accounting (¥). Managers only.
- [x] Commission payment's amount is the commission; the old Commission and
      Paid by columns are gone.
- [x] For a manager each chip opens Accounting filtered to that PO and kind
      (purchase / commission), all dates.

## Out of scope

Mobile PO list; the PO page's own payment cards.
