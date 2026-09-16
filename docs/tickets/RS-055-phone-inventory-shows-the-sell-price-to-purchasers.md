---
id: RS-055
title: Phone Inventory shows the sell price to purchasers
type: task
status: done
priority: P3
created: 2026-09-15
reporter: jinhu
branch: feat/mobile-inventory-sell-price
pr: 335
version: 1.144.2
related: []
---

## Ask

> also unhide the market price in the mobile page for purchaser.

## Context

The phone Inventory list rendered each line's recorded sell price under the
status chip for managers only. The gate dated from the initial commit and was
out of step with everything around it: the desktop Inventory table shows
Sell price to every role (only Unit cost, Profit and Margin are
manager-only), `GET /api/inventory` already sends `sell_price` to purchasers
(it strips only cost, profit and margin — "Sell price stays visible — it is
not sensitive"), the phone Orders list shows each line's sell price to
everyone, and the phone Market page shows reference prices and max buy to
purchasers. The phone was hiding a number it had already been given.

"Market price" here is the line's `sell_price` — the value the phone
capture form's Market panel writes with "Use sell price".

## Acceptance criteria

- [x] On the phone Inventory list a purchaser sees the sell price under the
      status chip for every line that has one; lines without one show
      nothing extra.
- [x] Managers see exactly what they saw before.

## Out of scope

- Unit cost, profit and margin on the phone: manager-only on the desktop
  too, and the API does not send them to purchasers.
- A purchaser quick link to Inventory on the phone Home. The tab bar has no
  Inventory tab for any role and Home's Inventory link is manager-only, so a
  purchaser reaches `/inventory` by URL. Not asked for; a one-liner of the
  same shape if wanted.
- The desktop grouped (outward) view, which carries no prices by design
  (v1.51.0).

## Notes

- One-line frontend change; no API, i18n or CSS involved.
