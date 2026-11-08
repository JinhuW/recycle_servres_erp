---
id: RS-572
title: Cost Payment Business Account: link a PayPal or Mercury payment once, no screenshot
type: story
status: done
priority: P2
created: 2026-11-08
reporter: jinhu
branch: JinhuW/catfish
pr:
version: 1.447.0
related: []
---

## Ask

> [screenshot: PO ▸ Cost Payment ▸ Business Account, showing the PayPal transaction ID box, the optional payment screenshot, the transaction search and a linked "Bank payments" row]
>
> The screenshot upload for the cost payment is not required.
>
>
> When user select business account, it should not limited to paypal, but also mercury bank transfer.
>
>
> Pls also avoid link twic here.

## Context

A manager's PO page (`DesktopEditOrder.tsx`) offers the Cost Payment a
RMB Flow | Business Account switch. The Business Account side rendered
`PaymentFields`' proof panel (PayPal transaction ID + optional screenshot)
above `BankTxnLinkPicker` and `PoPaymentsLedger`. The ID box and the picker
are two roads to the same link (the PayPal sync auto-links a typed ID), the
box reads as PayPal-only although the picker already lists Mercury, and the
picker stayed up after a payment was linked. The backend rule
(`services/orderTxnRule.ts`, `costPaymentLinked`) already accepts a linked
PayPal or Mercury payment instead of a typed ID, so the change is frontend
only.

Asked which "link twice" meant, the owner picked both: one way to link, and
no second link once one is on file.

## Acceptance criteria

- [x] Manager PO page, Business Account: no PayPal transaction ID box and no screenshot upload on the Cost Payment tab.
- [x] The transaction search (PayPal + Mercury, unlinked, settled, outgoing) is the only way to link there, and its placeholder names both.
- [x] Once a payment is linked to the PO's cost the search is hidden and only Bank payments shows; unlinking stays on the Payments page.
- [x] A transaction ID already typed by the purchaser shows read-only while nothing is linked.
- [x] Purchaser flows (hand-off dialog, phone sheet, create pages, non-manager PO page) are unchanged.
- [x] The readiness wording for a missing ID reads "the PayPal transaction ID or a linked bank payment".

## Out of scope

Backend rules; the Commission tab picker; split cost payments from the PO
page (the Payments page still links more than one).

## Notes

Plan: one-off, approved in session; no spec.
