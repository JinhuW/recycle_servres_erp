---
id: RS-490
title: Cost Payment picks RMB Flow or Business Account like Commission
type: story
status: done
priority: P2
created: 2026-10-31
reporter: jinhu
branch: JinhuW/sardine-2
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1040
version: 1.397.0
related: []
---

## Ask

> It can be both RMB pr Business Account which is similiar with the commission sections

(Sent with a screenshot of a PO's Cost Payment tab: Paid by = Business Account,
Method = Cash, and the RMB Flow card below saying "This was paid from the
Business Account, so it belongs on Payments, not the RMB Flow.")

## Context

A PO's cost has one payer: `orders.payment` (`company` | `self`) plus
`paid_by`. On the Cost Payment tab that is one select whose first option is the
Business Account and whose other options are people
(`components/PaymentFields.tsx`), with the RMB Flow card under it. A
Business-paid PO takes no RMB entries: migration 0199's trigger voids them and
`routes/accounting.ts` refuses new ones (`COMPANY_COST_MSG`). So on a
Business-paid PO the card is a dead end.

The Commission tab already presents its two sources as a
`[RMB Flow | Business Account]` switch (`components/CommissionPaymentFields.tsx`).
The cost side should read the same way. Asked whether one cost should be split
across both sources or pick one with a toggle, the owner chose the toggle
(2026-10-31), so the backend rule stays and the change is frontend only.

## Acceptance criteria

- [x] For managers, the Cost Payment tab (desktop PO page and phone PO page) opens with a `[RMB Flow | Business Account]` switch, styled like Commission's.
- [x] **Business Account** sets the payment to company and shows Method (PayPal/Cash), the proof panel and the Payments ledger, as today.
- [x] **RMB Flow** sets the payment to self and shows a Paid by select of people only (no Business Account option), the chat-proof panel, and the RMB Flow card with its Record button.
- [x] Moving to RMB Flow keeps the current payer when there is one, otherwise picks the signed-in manager.
- [x] While the saved PO is still Business-paid, the RMB side asks to save first instead of showing "belongs on Payments".
- [x] A locked payer (`payerLocked`) disables the switch as it locks the select.
- [x] Purchasers, the create pages and the hand-off dialog keep today's single select.

## Out of scope

- Splitting one cost across RMB and the Business Account — considered and declined by the owner on 2026-10-31.
- Any backend or migration change.
