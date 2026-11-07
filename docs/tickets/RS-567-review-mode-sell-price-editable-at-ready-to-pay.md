---
id: RS-567
title: Review mode: sell price editable at Ready to Pay
type: bug
status: done
priority: P2
created: 2026-11-07
reporter: jinhu
branch: JinhuW/hotfix-review-sell-price
pr: 1161
version: 1.444.1
related: []
---

## Ask

> Update the access that when order is ready to pay, The unit sell price is still editable. 
>
> make the change in the main and release it

> Sorry i meant the review mode.

## Context

From Ready to Pay the PO is closed book: `PATCH /api/orders/:id` refuses any
line edit (`routes/orders/patch.ts`, `doneLocked`, 409). The sell price is the
exception (RS-131, v1.191.1): it goes through `PATCH /api/inventory/:id`, which
takes `sellPrice` on a closed-book PO. Review mode's inline *Sell / Unit* column
already uses that route, but its **Edit drawer** sent the whole line through the
PO route, so a manager changing the sell price there at Ready to Pay got a 409.
Prod logs show two such refusals on PO-1480 on 2026-11-07.

## Acceptance criteria

- [x] At Ready to Pay, Review mode's Edit drawer opens view-only with the unit
      sell price still editable, as the PO page's drawer does.
- [x] Its Save writes the price through the inventory line PATCH; a refusal
      keeps the drawer open and says why.
- [x] At Done the drawer is view-only, with no live field (the PO page's rule).
- [x] Before Ready to Pay the drawer is unchanged.

## Out of scope

- Apply-count and AI-finding fixes in Review mode at Ready to Pay still send line
  patches the server refuses; they change goods, not price, so they stay
  closed-book.
- The phone PO page, which has no sell-price edit past review.

## Notes

Shipped as a hotfix PR straight to `main` at the owner's request, then `main`
merged back into `dev`, so `dev`'s unreleased RS-554 stays unreleased.
