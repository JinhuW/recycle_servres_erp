---
id: RS-050
title: Draft → In Transit hands off delivery and payment in one dialog
type: story
status: backlog
priority: P2
created: 2026-09-14
reporter: Jinhu
branch: session/20260914-024945
pr:
version:
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

- **Self-paid orders never ask for a PayPal transaction ID** — they are
  reimbursed from commission, not matched against the bank.  The field stays
  behind an "add it anyway" link.
- **Self-paid orders require a chat-history screenshot** — the conversation
  with the seller showing what was agreed and paid, which is what the
  reimbursement is checked against.
- **No "Other" payment method** — PayPal or Cash.

The work is in two phases.  **Phase A** (this ticket's first PR) is the mock
and this record.  **Phase B** — migration, backend rule change, desktop dialog,
mobile sheet — gets its own plan once the mock is signed off.

## Acceptance criteria

Phase A:

- [ ] A self-contained mock at `docs/superpowers/specs/2026-09-14-in-transit-dialog-mock.html`, published as an artifact, shows the dialog in the app's own visual language with both delivery paths, both payment types, the three payment methods, the optional screenshot, and the manager-only fields.
- [ ] The mock's blocked states match the backend's: a label with no valid tracking number, and company card + PayPal with no transaction ID.

Phase B:

- [ ] Clicking In Transit from Draft on the desktop PO page opens the dialog; confirming saves its fields and advances the PO in one action.
- [ ] Local pickup is recorded on the PO (method + who collected it) and the PO reads In Transit.
- [ ] A tracking number entered in the dialog creates the tracked package linked to this PO.
- [ ] A company-paid PO whose payment method is Cash or Other advances without a transaction ID; PayPal still requires it.
- [ ] The screenshot is optional on every path; when attached it still fills the transaction ID.
- [ ] Mobile offers the same choices when advancing from Draft.

## Out of scope

- Buying a prepaid label from inside the dialog (stays on the Shipping page).
- Skipping In Transit for pickups.
- The phone-shell design; the mock's narrow view is a narrow desktop dialog.

## Notes

- Plan: `~/.claude/plans/playful-wishing-whisper.md` (session 2026-09-14).
- Artifact (clickable mock): https://claude.ai/code/artifact/b54f9175-82fe-4d1f-9186-868a15396372
- Open questions surfaced with the mock:
  1. `POST /api/packages` requires a source (Facebook / Local / Reddit / Other). Ask in the dialog, or derive from the PO's client?
  2. "Picked up by" as free text, or a member picker?
  3. A tracking number entered here links the package to this PO and advances immediately — confirm.
  4. Clients already record *they ship / we send a label / we pick up / they drop off*. Pre-select the tile from the client, and is "they drop off" a third tile or part of Local pickup?
- Confirm commits immediately (saves + advances), unlike the Done dialog which only stages the status for Save. A hand-off that merely staged would let a purchaser close the tab with the PO still Draft.
- Phase B column names: `handoff_method`, `handoff_by`, `payment_method` — not `delivery_method`, which the Facebook-listing coordinator already uses.
