---
id: RS-050
title: Draft → In Transit hands off delivery and payment in one dialog
type: story
status: done
priority: P2
created: 2026-09-14
reporter: Jinhu
branch: session/20260914-024945
pr: 327
version: 1.142.0
related: []
---

## Ask

> The current shipping is adding to a dedicated page. i think it maybe make
> more sense while user move from draft to in transit.
>
> It should has both local pick up or shipping lables.
>
> reuse this page,
>
> [Image #1]
>
> PayPal payment screenshot should also be optional as user may use cash pay.
>
> /frontend-design:frontend-design based on this request, think of the UIUX
> design. let we build and protatetype

Image #1 was a mockup of a "Mark as In Transit" dialog: *Provide receiving and
payment details* — Receiving warehouse, Purchaser, Payment type ("Self pay —
reimbursed"), a PayPal payment screenshot upload reading "Attach the PayPal
payment screenshot before marking this order as In Transit", Commission rate,
then Cancel / Mark as In Transit.  Nothing in the app renders that dialog; it
is the target, not the current state.

## Context

Today the Draft → In Transit move is a stepper click plus Save on the desktop
PO page and a single button on mobile; neither asks how the goods are getting
here.  Shipping lives on its own page: prepaid labels through the wizard, and
external labels through Add-package, which becomes a PO only once the box is
delivered.  There is no notion of a local pickup at all, and a company-paid PO
cannot leave Draft without a PayPal transaction ID (v1.115.0) even when the
seller was paid in cash.

Decisions taken with Jinhu on 2026-09-14:

| Question | Decision |
| --- | --- |
| Status after a local pickup | In Transit, same as a shipped PO |
| What "Shipping label" means in the dialog | Paste a tracking number (carrier auto-detected); the prepaid-label wizard stays on the Shipping page |
| Cash vs the company-pay transaction-ID rule | Add a payment method (PayPal / Cash); the ID is required only for PayPal + company card; the PayPal screenshot is optional everywhere |
| How to prototype | Clickable HTML mock first; real build after sign-off |

Corrections from the first look at the mock (Jinhu, same day):

- **Self-paid orders ask for no payment method and no PayPal transaction
  ID** — they are reimbursed from commission, not matched against the bank.
- **Self-paid orders require a chat-history screenshot** — the conversation
  with the seller showing what was agreed and paid, which is what the
  reimbursement is checked against.
- **Method (PayPal / Cash) belongs to the company card only**, and there is no
  "Other".  Company + PayPal requires the transaction ID; Company + Cash needs
  nothing more.

The work is in two phases.  **Phase A** (this ticket's first PR) is the mock
and this record.  **Phase B** — migration, backend rule change, desktop dialog,
mobile sheet — gets its own plan once the mock is signed off.

## Acceptance criteria

Phase A:

- [x] A self-contained mock at `docs/superpowers/specs/2026-09-14-in-transit-dialog-mock.html`, published as an artifact, shows the dialog in the app's own visual language with both delivery paths, both payment types, the company card's PayPal / Cash method, the optional PayPal screenshot, the required chat-history screenshot for self-paid orders, and the manager-only fields.
- [x] The mock's blocked states: a label with no valid tracking number, company card + PayPal with no transaction ID, and a self-paid order with no chat-history screenshot.

Phase B:

- [x] Clicking In Transit from Draft on the desktop PO page opens the dialog; confirming saves its fields and advances the PO in one action.
- [x] Local pickup is recorded on the PO (method + who collected it) and the PO reads In Transit.
- [x] A tracking number entered in the dialog creates the tracked package linked to this PO.
- [x] A company-paid PO whose payment method is Cash advances without a transaction ID; PayPal still requires it.
- [x] A self-paid PO asks for no method and no transaction ID, and refuses to advance without a chat-history screenshot attached.
- [x] The PayPal screenshot stays optional; when attached it still fills the transaction ID.
- [x] The dialog asks for the order's source (Facebook / Local / Reddit / Other); it is saved on the PO and a package created from the dialog carries it.
- [x] "Picked up by" is a member picker.
- [x] The Shipping entry is hidden from the navigation.
- [x] Mobile offers the same choices when advancing from Draft.

## Out of scope

- Buying a prepaid label from inside the dialog (stays on the Shipping page).
- Skipping In Transit for pickups.
- The phone-shell design; the mock's narrow view is a narrow desktop dialog.

## Notes

- Plan: `~/.claude/plans/playful-wishing-whisper.md` (session 2026-09-14). Phase A shipped in #327 (docs-only); phase B is the release below.
- Every hand-off change is logged (Jinhu, after plan review: "the update to the table should also log in the events/activities") — a `meta_changed` per field plus a `handoff` event.
- Artifact (clickable mock): https://claude.ai/code/artifact/b54f9175-82fe-4d1f-9186-868a15396372
- Open questions surfaced with the mock, answered by Jinhu on 2026-09-14:
  1. Package source (Facebook / Local / Reddit / Other) → **"add a source for the order"**: the dialog asks for it and it is stored on the PO; a package created from the dialog inherits it.
  2. "Picked up by" → **member picker**.
  3. A tracking number entered here links the package to this PO and advances immediately → **yes**.
  4. Client ship-preference prefill / drop-off tile → **"hide the shipping menu for now"**: no prefill, drop-off stays part of Local pickup, and phase B hides the Shipping entry from the navigation.
- Confirm commits immediately (saves + advances), unlike the Done dialog which only stages the status for Save. A hand-off that merely staged would let a purchaser close the tab with the PO still Draft.
- Phase B column names: `handoff_method`, `handoff_by`, `payment_method` — not `delivery_method`, which the Facebook-listing coordinator already uses.
