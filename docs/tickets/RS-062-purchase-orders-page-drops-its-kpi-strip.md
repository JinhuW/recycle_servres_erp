---
id: RS-062
title: Purchase orders page drops its KPI strip
type: task
status: in-review
priority: P3
created: 2026-09-17
reporter: jinhu
branch: chore/orders-page-no-kpis
pr:
version: 1.147.2
related: [RS-059, RS-061]
---

## Ask

With a screenshot of the desktop Purchase orders page, the subtitle line and
the four tiles (Total orders 78, Total revenue $146,937 · 749 unpriced,
Gross profit $69,534, Commission paid $33,402) boxed in red:

> also remove this section from the Purchaser order page.

The screenshot was pasted inline and is not on disk.

## Context

The desktop Purchase orders page (`pages/desktop/DesktopOrders.tsx`) has
opened with a subtitle and a four-tile KPI strip since the first release.
The tiles are computed in the browser over whatever the stage and category
filters currently show, with no reporting window, so they are a second copy
of figures the dashboard now states properly (RS-059, RS-061) — and a copy
that disagrees with it whenever a filter is on.  Removing them puts the
orders card at the top of the page.

## Acceptance criteria

- [x] The desktop Purchase orders page opens with the title and, directly
      under it, the orders card; no subtitle, no KPI tiles.
- [x] The card head's "{n} lines" caption and the per-row unpriced badge are
      unchanged.
- [x] No dead CSS or i18n keys are left behind for the removed strip;
      `en` and `zh` in parity.
- [x] The phone Orders page is unchanged.

## Out of scope

- The phone Orders page — its header reads "{n} submitted", not this strip.
- The pipeline / stage rail on the card head.
- Trimming `revenue`, `profit` and `unpricedLineCount` from the list API —
  table columns still read them.
