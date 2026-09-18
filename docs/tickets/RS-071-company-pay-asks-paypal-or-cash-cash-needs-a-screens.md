---
id: RS-071
title: Company pay asks PayPal or Cash; cash needs a screenshot of the amount paid
type: story
status: done
priority: P2
created: 2026-09-18
reporter: Jinhu
branch: session/20260918-102150
pr: 357
version: 1.153.0
related: [RS-050, RS-069]
---

## Ask

> /frontend-design:frontend-design when user select company paid and it
> should also prompt to selet paypal pad or cash pay.
>
> for all cash pay, it should submit a screenshot to indicate the total
> amount.

Then, mid-plan:

> help me refine the entire UIUX for select payment and how provdie the
> sceenshot for the payments.

## Context

A PO's payment is picked in five places and each asks a different question.
The create pages (desktop Submit, phone Review) offer only Company / Self-paid;
the PO pages (desktop Edit, phone Detail) add a PayPal transaction-ID box that
is always visible; PayPal-vs-Cash is asked only inside the In-Transit hand-off
dialog (RS-050, v1.142.0), where Cash "needs nothing more". A cash payment
therefore leaves no trace of what was handed over, and a company PO whose
method was never asked is silently treated as PayPal.

Decisions taken with Jinhu on 2026-09-18:

| Question | Decision |
| --- | --- |
| Shape of the picker | Two steps: *Paid by* (Company card / Self-paid), then *Method* (PayPal / Cash) revealed under Company card — not a single three-way choice |
| When the cash screenshot is required | To leave Draft — the same door as the transaction-ID and chat-screenshot rules, grandfathered by a cutoff stamped when the release reaches the environment |

Design: one `PaymentFields` component (Paid by → Method → a *proof panel*
whose heading names exactly what the chosen path needs) replaces every
hand-rolled picker. Cash proof lives in its own `Payment` attachment bucket
on the order, apart from Submission receipts and manifests, so only a file
offered as proof of payment satisfies the rule.

## Acceptance criteria

- [x] Every place a PO's payment is chosen (desktop Submit, desktop Edit, phone Review, phone Detail, the In-Transit dialog and phone sheet) shows the same picker: Paid by, then PayPal / Cash under Company card.
- [x] Under Company · Cash the proof panel asks for a screenshot showing the total amount paid; under Company · PayPal it asks for the transaction ID with the optional screenshot that reads it; under Self-paid it asks for the chat with the seller. Each names its requirement before anything is typed.
- [x] A Company · Cash PO created after the release refuses to leave Draft — hand-off, manager stage-jump, carrier poll — until a `Payment` attachment is on file; the refusal names the fix. A Submission attachment does not satisfy it.
- [x] A company PO with no method yet is asked for one in the hand-off dialog instead of being treated as PayPal.
- [x] `paymentMethod` is saved from the PO pages and create pages (POST / PATCH), logged on the activity log, and cleared when the PO flips to Self-paid.
- [x] GET `/api/orders/:id` reports `cashShotRequired` beside `txnRequired` and `chatShotRequired`.
- [x] POs on file before the release are exempt from the cash rule.

## Out of scope

- Persisting the PayPal screenshot dropped into the hand-off dialog on the
  order (today it survives only on a label's package row) — the 2026-09-14
  review finding, now RS-073.
- Moving self-paid chat screenshots out of Submission.
- The 14 prod POs carrying `CASH*` placeholder transaction IDs with no
  method — a separate data fix.
- Collecting proof on the create pages (no order id exists yet); the hand-off
  is the gate.

## Notes

- Plan: `~/.claude/plans/vivid-sprouting-milner.md` (session 2026-09-18).
- Migration `0128` widens the status-meta CHECKs to add `Payment` and stamps
  `po_cash_shot_required_from`.
- Plan review cut two things from the first draft: persisting the PayPal
  screenshot on the order (→ RS-073) and moving self-paid chat uploads to the
  `Payment` bucket (no rule change, only a legacy branch). Reusing
  `Submission` for cash proof was rejected because a lot manifest would have
  satisfied the rule.
- Verified in the browser on 2026-09-18: desktop Submit / Edit, phone Review /
  Detail, the dialog and the sheet; a cash PO refused the hand-off until a
  screenshot was attached, then advanced with the file in the `Payment`
  bucket.
