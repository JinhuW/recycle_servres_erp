---
id: RS-350
title: Paid by names a manager or the Business Account
type: story
status: done
priority: P2
created: 2026-10-22
reporter: jinhu
branch: feat/po-paid-by-payer
pr: 826
version: 1.315.0
related: [RS-328, RS-349]
---

## Ask

> The Paid by can be three type.
>
> Jinhu, Tim any manager. also can be Business Account.
>
> Pls update the PO and accounting page to reflect the change.
> when it can be linked to the mercury or paypal, then it can catagorized as Business Account

## Context

A PO's cost *Paid by* is `orders.payment`, `'company'` or `'self'` (CHECK in
migration 0143): *Company card*, then a Method of PayPal or Cash, or
*Self-paid*, the purchaser paid out of pocket and is reimbursed the cost
through their commission. Auto-link (`banktx/sync.ts`) and the
transaction-id rule apply only to `'company'`; `'self'` is governed by the
chat-screenshot rule. The picker is one component,
`components/PaymentFields.tsx`, behind the create pages, both PO pages, the
hand-off dialog and the phone sheet.

RS-349 (v1.314.0) booked commissions and sales into the Accounting book and
left the cost *Paid by* out because it named a card, not a manager, so there
was no one to book it to. The commission *Paid by* (RS-328, v1.301.0)
already offers the managers and *Company paid*, and reads *Company paid*
while a bank row is linked as the commission.

The ask names the three kinds of cost payer: a manager in person, or the
company's own account — the one whose payments appear in Mercury and
PayPal. That is exactly what `'company'` means today, so the stored value
and its rules stay; what changes is that a person-paid PO records *which*
person, the labels say Business Account, and the book can pre-fill the
payer.

## Acceptance criteria

- [x] Cost Paid by offers Business Account and each active manager by name,
      on the create pages, both PO pages, the hand-off dialog and sheet. The
      PO's purchaser is also offered when they are not a manager.
- [x] Business Account keeps Method (PayPal / Cash), the transaction-id and
      auto-link rules; a person-paid PO keeps the chat rule.
- [x] The reimbursement line goes to the payer: the purchaser's earnings
      include the cost only when the purchaser paid it; when another manager
      paid, the Commission tab says who is reimbursed.
- [x] PO list: the Payment cell and the filter chips read Business / the
      payer's name.
- [x] The commission Paid by's "Company paid" reads "Business Account".
- [x] Accounting: the Cost Payment card's Record (desktop and phone) and the
      entry dialog's PO pick default Manager to the PO's payer when the payer
      is an active manager (cost: `paid_by`; commission:
      `commission_paid_by`); otherwise the recorder, as today. A manager
      already picked by hand, or an entry being edited, is left alone.
- [x] Accounting: a PO in the picker and on the cards names its payer, and
      reads Business Account when the cost was paid from the company's
      account or the commission was (on file, or a live Mercury/PayPal row
      linked as it).
- [x] Changing the payer is an Activity line.
- [x] Existing self-paid POs read as paid by their purchaser.

## Out of scope

- Renaming the stored values or the `orders_payment_ck` CHECK (root
  AGENTS.md fixed rule: the set stays Company pay / Self pay).
- Booking Business Account money in the RMB book (it is the USD bank,
  reconciled on Payments) and a purchase backfill from the cost payer.
- Paying a manager back; per-manager reimbursement reports.
- A bank row hand-linked to a person-paid PO is that person's reimbursement
  (FEATURES, payment gap: self-paid POs), not the cost payment, so the cost
  cell keeps the payer's name beside the linked chip.
- A Purchase entry does not write the cost payer back. The Commission entry
  does fill the commission payer (`fillPayerTx`); the asymmetry is a
  decision, not an oversight.

## Notes

- The payer is a record of who paid: a later owner change leaves it.
- Activity history written before this release still reads "Company" for a
  commission paid by the business (`routes/orders/shared.ts
  recordPayerTx`); only the live labels say Business Account.
- Migration 0197 backfills `paid_by = user_id` on every self-paid PO: the
  owner is who the system already reimburses, so the record matches the
  books.
- Plan: `~/.claude/plans/mossy-hopping-dijkstra.md` (session plan, not in
  repo), reviewed twice; the first draft was written against a v1.260.0
  checkout and redone for v1.314.0, where the Accounting page exists.
