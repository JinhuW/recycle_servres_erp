---
id: RS-056
title: Phone tab bar shows the Market tab to purchasers
type: story
status: done
priority: P2
created: 2026-09-16
reporter: jinhu
branch: feat/phone-market-tab
pr: 336
version: 1.145.0
related: [RS-050, RS-055]
---

## Ask

> unhide the market price tab in the purchaser view

## Context

The phone tab bar gave purchasers a fourth tab, Market, from the first
commit. v1.80.0 put Shipping in that slot ("Market keeps a quick link on
Home"), and v1.142.0 (RS-050) unlisted Shipping without refilling the slot,
so a purchaser's bar has read Home · Orders · Capture · Profile since then.
Market survived on the phone only as a Home quick link and by URL
(`#/market`).

Nothing else hides Market from purchasers: the desktop sidebar lists it for
both roles, the desktop view bounce leaves it alone, the phone shell renders
the page for every role, and `GET /api/market` has no role check (only the
manual price edit is manager-only). The tab bar was the one surface left.

RS-055 read a near-identical ask as the sell price on the phone Inventory
list; this ticket is the tab itself.

## Acceptance criteria

- [x] On the phone, a purchaser's tab bar shows Market between Capture and
      Profile; tapping it opens the Market price list and the tab is lit
      while on `#/market`.
- [x] A manager previewing as a purchaser sees the same tab.
- [x] A manager's own tab bar is unchanged (Home · Orders · Capture ·
      Profile).
- [x] Both locales have a label for the tab (`i18nParity` and
      `i18nCoverage` tests pass).

## Out of scope

- A manager Inventory tab. It left the bar in v1.80.0 for the same reason
  and lives as a Home quick link; not asked for.
- The purchaser "Market prices" row on phone Home. It now duplicates the
  tab; kept, since the ask was the tab. One-block deletion if wanted.
- The desktop shell, where Market was never hidden.

## Notes

- `tabMarket` had been removed from both locales in the v1.83.4 dead-code
  sweep; restored with its old values (`Market` / `市场`).
- `.ph-tabbar` is a five-column grid, so the purchaser's five tabs fill it
  exactly and the manager's four leave the fifth column empty as they have
  since v1.142.0.
- The tab bar reads the effective user (the "preview as purchaser" tweak)
  rather than taking a role prop, the same way the desktop sidebar does.
