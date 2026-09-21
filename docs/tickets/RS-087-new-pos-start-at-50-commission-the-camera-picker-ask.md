---
id: RS-087
title: New POs start at 50% commission; the camera picker asks which item to add; Submit opens the PO
type: story
status: in-progress
priority: P2
created: 2026-09-20
reporter: jinhu
branch: feat/rs-087-commission-default-capture-focus
pr:
version: 1.166.0
related: [RS-060, RS-083]
---

## Ask

> update followng features:
> 1. commission rate set to 50% by default.
> 2. In the mobile page, when user click the camear button and select an PO. It will focus on submit products.
>
> Once user submit the order, It will go back the page that user click the edit. instead of go back the PO list.

Follow-up answers: the 50% applies to **new POs only** — existing rate-less
POs stay as they are; "focus on submit products" means **go straight to
adding a product** (a category chooser, then the line form); after Submit
the phone opens **the submitted PO's own page**.

## Context

- No default exists today: `orders.commission_rate` is nullable, NULL reads
  as 0% everywhere (dashboard, `/api/me`, realized profit), and migration
  0030 dropped the old configurable defaults on purpose (RS-060). The desktop
  edit page seeds its input with 0, the phone with blank. No create path —
  `POST /api/orders`, `POST /api/orders/draft`, the package → PO path —
  writes the column, so a column default covers all three.
- The phone's camera FAB (`PhTabBar` centre button; also the Home "Scan with
  AI" card and Inventory "+") lists the user's Draft POs
  (`PhDraftPickerSheet`); picking one opened the Review screen
  (`OrderReview`) — the line list, then the Delivery and Payment folds open —
  and the four add-category targets sat below the lines.
- Review's Submit (`MobileApp.submitOrder`) navigated to `#/purchase-orders`
  regardless of where the capture was started or which PO it was.

## Acceptance criteria

- [x] A PO created through `POST /api/orders`, `POST /api/orders/draft`, or
      the package → PO path carries `commissionRate = 0.5` on first read.
- [x] Existing POs with `commission_rate IS NULL` are unchanged; PATCH with
      `commissionRate: null` still clears the rate.
- [x] Camera FAB → pick a draft → a sheet asks which kind of item (RAM / SSD /
      HDD / Other, the same four targets as Review's add row) over the Review
      screen; picking one opens the line form for that draft; dismissing the
      sheet leaves the user on Review as before.
- [x] Shipping's "Create PO" still opens Review without the sheet.
- [x] Submit on Review opens `#/purchase-orders/<id>` of the PO just
      submitted (both the create and the PATCH-a-draft path); the toast still
      shows.

## Out of scope

- Backfilling 50% onto existing rate-less POs.
- "Start a new order" from the picker — it already lands on the empty Review
  whose add row is the first thing on screen.
- Desktop.

## Notes

- Plan: `~/.claude/plans/giggly-cooking-donut.md`.
- The default is a column `DEFAULT 0.5`, not a value written by each create
  path: NULL keeps meaning "no rate" for pre-existing rows and for a manager
  who clears it.
