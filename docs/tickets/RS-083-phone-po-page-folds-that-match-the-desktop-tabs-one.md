---
id: RS-083
title: phone PO page: folds that match the desktop tabs, one sheet per stage
type: story
status: in-progress
priority: P2
created: 2026-09-20
reporter: jinhu
branch: feat/rs-083-phone-folds
pr:
version:
related: [RS-080, RS-081]
---

## Ask

> The current mobile UI UX for the PO has miss match for different settings.
>
> 1. For each type of tab which we are using foldable tab here. I hope it has a clear boundary to know if it is collasp or not.
> 2. Each status , the pop up form should only include the related data.

> Give me an prototype to let me review

> i also noticed an issue that the UI has a miss match with the PO edit.

> There is one more inconsistence.
> [screenshot: the phone "Review order" step — Warehouse select, Payment
> (Paid by / Method) open inline, Order notes, a green Cost breakdown card]
> This page is when we create Po from the camear button.

Prototype reviewed before the plan: https://claude.ai/artifact/PyptpdScDmW9fevS7GwHvF
— answer: "Build it as shown".

## Context

RS-080 gave the desktop PO page five tabs (Delivery, Payment, Commission,
Notes & files, Activity) and RS-081 made the stage pick the tab. The phone
page (v1.161.x) kept its own arrangement: Delivery and Payment as bare
`.ph-fold-h` rows whose only open/closed cue was a chevron, Activity as a
full card, Warehouse as a loose select, no Commission section, and the Cost
card repeating the commission rate and PayPal transaction id. The phone's
"Review order" step (`pages/OrderReview.tsx`, the camera flow) asked the same
facts as plain open fields with a green cost card. Three surfaces, three
looks for one set of facts.

The Draft → In Transit checkpoint also asked managers for the commission,
which is what Ready to Pay settles, and Reviewing → Ready to Pay had no
confirmation at all on the phone.

## Acceptance criteria

- [ ] Every foldable section on the phone PO page is the same `PhFold` card:
      closed = title, read-back summary, chevron in a disc; open = tinted
      header with a rule under it, rotated chevron, fields inside the card.
- [ ] The sections are Delivery (incl. warehouse), Payment, Commission,
      Notes & files, Activity — the desktop tab names and order.
- [ ] Amber mark = the next step needs this section; blue mark = unsaved
      edit here. The Cost card no longer shows the commission rate or the
      PayPal transaction id.
- [ ] Commission is editable by managers until Ready to Pay (sourced by,
      rate), read-only for everyone else.
- [ ] The stage opens its fold: Draft → first amber fold, In Transit →
      Delivery, Ready to Pay → Commission; the user can still open any fold.
- [ ] Draft → In Transit asks Products / Delivery / Payment only (desktop
      dialog too). Reviewing → Ready to Pay (manager) opens a Commission
      sheet that saves the commission and advances. Done keeps its evidence
      dialog.
- [ ] The "Review order" step uses the same folds (Delivery = warehouse,
      Payment, Notes) and the white cost card; its payload is unchanged.

## Out of scope

- Files on the Review order step (attachments need an order id).
- A Commission confirm on the desktop *Mark as Ready to Pay* (the Commission
  tab is already the stage's tab there).
- Lifting the Review order step's warehouse/payment/notes into `MobileApp`
  so they survive a trip into a line form — pre-existing loss, separate
  ticket.

## Notes

- Plan: `~/.claude/plans/yes-ultrathink-lovely-widget.md` (reviewed).
- `PaymentFields` has no phone class of its own; the one-column layout at
  390px comes from the ancestor `.ph-pay` rule, so the Payment fold body
  keeps that class on both pages.
