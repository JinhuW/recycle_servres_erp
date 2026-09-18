---
id: RS-074
title: Split the phone PO page into general info and products; list rows open instead of expanding
type: story
status: in-progress
priority: P2
created: 2026-09-18
reporter: jinhu
branch: session/20260918-163518
pr:
version:
related: []
---

## Ask

> Help me refine the UI UX for how purchaser manage their PO and submit orders.
>
> 1. this list is not longer to collasp any more. cuz the list maybe to long. add an edit button on the side.
> 2. I would like to seperate the order general info page with the product edit page.

Sent with a screenshot of the phone PO list (PO-1440 … PO-1446, 1–27 items
each, every row carrying a chevron). Then, after the design was agreed:

> yes. also refine the edit page. to make it more user friendly and info clear.

And, with a screenshot of the Payment fields (Paid by / Method / PayPal
transaction ID / Payment screenshot) on the order screen:

> The entire payment section can be foldable. and it should fold by default

## Context

Purchasers manage their POs on the phone. The list expanded a row inline,
lazily fetching its lines, and the only way into the PO was a small "Edit"
button at the *bottom* of that expanded body — on an 18-line PO it sat more
than a screen below the row. The PO page itself put everything on one scroll:
status stepper and Submit, shipping, every product card with the add-category
dock, the cost card, warehouse / payment / notes / proof, activity — and the
bottom bar carried the dock plus four buttons.

Decisions:

- **Phone shell only.** The desktop PO table and `DesktopEditOrder` are
  untouched, except that a products-screen link opened on a laptop lands on
  that PO rather than the dashboard.
- **Rows navigate, they don't expand.** The whole card opens the PO; the
  chevron becomes a pencil (editable) or an eye (Ready to Pay / Done /
  archived), so the list itself says which POs are still the purchaser's to
  change.
- **Info first, products behind a row.** `/purchase-orders/:id` is the
  general-info screen; a "Products · n" row on it opens
  `/purchase-orders/:id/products`, which owns the line cards, the add dock and
  the line form round-trip.  One component renders both screens so a line
  removed on one is already gone on the other and the "this sends the PO back
  to Draft" warning is asked once per visit, not once per screen.
- **The payment fields fold by default.** They were answered when the PO was
  raised; the fold's header reads back the answer (`Company · PayPal · 8XY…`
  or `Self-paid`), and a readiness row that names a payment gap opens it.
- **The info screen says what still blocks Submit.**  A readiness list under
  the stepper (Draft only) is derived from the same `handoffBlockerKeys` the
  hand-off sheet uses, plus the products/cost rule the page already enforced,
  so it cannot disagree with the sheet or the server's 409.

## Acceptance criteria

- [ ] On the phone PO list no row expands; tapping a row, or its right-hand
      icon button, opens `/purchase-orders/:id`. Editable POs show a pencil,
      locked ones an eye.
- [ ] `/purchase-orders/:id` shows the PO id as its title, the status stepper,
      the readiness list (Draft only), a "Products · n" row, the shipping row,
      the cost card, the order fields and the activity log — no line cards, no
      add dock.
- [ ] `/purchase-orders/:id/products` shows the line cards, the add-category
      dock (editable POs only) and the goods total; tapping a line opens the
      line form, and saving or backing out of it returns to the products
      screen; the back arrow returns to the info screen.
- [ ] Removing a line on the products screen, then going back, shows the new
      count and goods total on the info screen; a fee typed on the info screen
      survives a trip to the products screen and back.
- [ ] The Payment fields on the info screen are folded by default behind a
      header that summarises paid-by / method / transaction id; tapping the
      header or an unmet payment row in the readiness list opens them.
- [ ] The readiness list flips rows as the unsaved Paid-by / method / txn id
      change, and shows the products row unmet for a never-submitted PO with
      no goods cost.
- [ ] `#/purchase-orders/PO-xxxx/products` opens the products screen directly
      on the phone and that PO on desktop.

## Out of scope

The new-PO review screen (`pages/OrderReview.tsx`, reached from the centre
tab) keeps its combined lines + meta layout. Desktop edit page unchanged.

## Notes

Plan: one `OrderDetail` component with a `section` prop rather than two
components — two would each hold a stale copy of the shell's `detailOrder`,
which only refetches on an id change.
