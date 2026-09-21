---
id: RS-090
title: Review screen shows only the products; the add row docks at the bottom
type: story
status: done
priority: P2
created: 2026-09-20
reporter: jinhu
branch: feat/rs-090-review-products-only
pr: 384
version: 1.169.0
related: [RS-087, RS-083]
---

## Ask

> You mis-understand my menas.
> > 2. Camera button → pick a PO → focus on products — picking a draft from
> > Continue a draft? now opens the Review screen with a sheet over it asking
> > Which kind of item is going in? (RAM / SSD / HDD / Other); the pick opens
> > the line form straight away. Dismissing the sheet leaves Review as before.
> > Shipping's Create PO is unchanged (no sheet).
>
> revert this change in your last change.
>
> [Image #19]
>  The goal is only show unbluer parts.
>
> Once user submit the order, It will move the edit page to fill the remaining
> page. It will help purchaser focus on scan items.
> [Image #20] this will alwasy stick to the buttom.

Two screenshots of the phone Review screen: the first with everything
below the *Add to this order* row (the Cost breakdown card and the Order
details folds) blurred and outlined in red; the second a crop of the *Add
to this order* row with its four dashed RAM / SSD / HDD / Other targets.

Follow-up answers: Submit submits right away and opens the PO's own page
(the v1.166.0 landing; the rest is filled in on its folds); the row docks
at the bottom above Cancel / Submit; this is how Review opens every time —
camera picker, Start a new order, Shipping's Create PO alike.

## Context

- v1.166.0 (RS-087) added a kind-of-item sheet over Review when a draft was
  picked from the camera button. Not what was asked; it goes.
- Review (`pages/OrderReview.tsx`) has carried the Cost breakdown card and
  the Delivery / Payment / Notes folds since v1.162.0 (RS-083) and sent
  all of that meta on Submit, unconditionally — including a client-side
  "first warehouse in the list" default that overrode the purchaser's own
  default warehouse. The PO page's folds ask the same questions, and the
  backend already defaults a new PO's warehouse to its owner's default and
  its payment to Company.

## Acceptance criteria

- [x] Review shows: header, PRODUCTS (empty state or line cards), and a
      docked *Add to this order* row (the four category targets) that stays
      above Cancel / Submit while the list scrolls. No cost card, no folds.
- [x] The v1.166.0 sheet is gone from every path into Review.
- [x] Submit sends lines only (create: `{ lines }`; draft: `addLines` /
      `removeLineIds`, or no request when there is nothing to send) and
      opens `#/purchase-orders/<id>`; a resumed draft's warehouse, payment,
      notes and fees are untouched; a new PO gets the owner's default
      warehouse (none → the Delivery fold on the PO page asks for it) and
      Company payment from the server.
- [x] Submit with no lines still raises the *Can't submit yet* dialog.

## Out of scope

- A two-step Submit that reveals the details (considered; Jinhu chose
  submit-now + PO page).
- The PO page's own products screen and dock (unchanged).

## Notes

- Plan: `~/.claude/plans/giggly-cooking-donut.md`.
- The dock keeps Review's taller +/name targets (the screenshot), not the
  PO page's 44px row.
