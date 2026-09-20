---
id: RS-084
title: Commission tab records how the commission was paid, and the Payment tab is Cost Payment
type: story
status: done
priority: P2
created: 2026-09-20
reporter: jinhu
branch: feat/rs-084-commission-payment
pr:
version: 1.163.0
related: [RS-080, RS-083, RS-071]
---

## Ask

> update a few UI and featire.
>
> 1. update the payment in the scrrenshot to an concept (Cost Payment)
> 2.In the commission section, also add an drop file box for upload screenshot for payments.
> 3. This section should default by paypal: [Image #17]. also note that screenshot withtransction id will auto fill the transcation id.
>
> [Image #16]
> [screenshots: the desktop PO page's tab strip with the *Payment* tab
> circled (Paid by: Company card / Self-paid; Method: PayPal / Cash); then the
> same tab with the *PayPal* option of the Method control circled]

Follow-up answers: build it for the desktop Commission tab **and** the phone
Commission fold; the record is optional — nothing gates Ready to Pay → Done.

## Context

The PO page's *Payment* tab (RS-080, v1.160.0) records how the **supplier**
was paid for the goods — paid by, method, PayPal transaction ID, proof files.
The *Commission* tab (desktop) and fold (phone, RS-083 v1.162.0) record who
earns the commission and how much, but nothing records how the **purchaser**
was paid it: the only trace is the optional "Mark order as Done" evidence
dialog, pitched as receiving proof. With two payments per PO the bare word
*Payment* is ambiguous; the tab becomes *Cost Payment* and the Commission
tab gains a payment record of its own.

The PayPal path of the Cost Payment already reads a transaction ID off a
dropped screenshot (`/api/scan/payment`, `usePaymentProof`); the commission
record reuses that OCR, run inside the upload so the screenshot is stored
under the order rather than left as a scan-only object.

## Acceptance criteria

- [x] The desktop tab, the phone fold, the phone Review step and the
      checkpoint / Ready-to-Pay sheet section all read **Cost Payment**.
- [x] The desktop Commission tab and the phone Commission fold carry a
      **Commission payment** block: PayPal | Cash with PayPal preselected, a
      transaction ID for PayPal, and a screenshot drop box. Managers edit it
      at any stage (closed book included); purchasers see it read-only.
- [x] A dropped PayPal screenshot fills an empty transaction ID from OCR and
      is kept on file under the order; method, ID and screenshots survive a
      reload and appear on the Activity log.
- [x] Nothing new blocks Ready to Pay → Done.

## Out of scope

- Linking the commission payment to the Payments ledger (PayPal sync rows).
- A Done gate on the commission record (asked; answered "optional").
- The "Mark order as Done" evidence dialog stays as it is.

## Notes

- Live-saved (a `PUT /api/orders/:id/commission-payment` plus the status-meta
  upload under a new `Commission` bucket), not part of the page's Save: the
  commission is paid when the PO is a closed book, where Save is disabled and
  PATCH refuses frozen fields.
- `commission_method` is nullable; the picker opens on PayPal, so the first
  real choice is an audited change and old POs don't claim a method nobody
  chose.
- The upload returns the scan and writes nothing from it; the client fills an
  empty ID and saves at once — a server-side write raced the debounced client
  save.
- Plan: `~/.claude/plans/cosmic-plotting-snowglobe.md`.
