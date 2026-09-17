---
id: RS-059
title: Dashboard time-range brush and contribution tables
type: story
status: done
priority: P2
created: 2026-09-17
reporter: jinhu
branch: feat/dashboard-insights
pr: 342
version: 1.146.0
related: [RS-051]
---

## Ask

Three screenshots of Mercury's *Insights* page came with the request; they
are kept as [RS-059-1.png](./assets/RS-059-1.png) (header, month strip,
chart), [RS-059-2.png](./assets/RS-059-2.png) (Money in / Money out tables)
and [RS-059-3.png](./assets/RS-059-3.png) (the brush close-up).

> ultrathink this dashboard, espeically for the timerange select.
> [Image #1]
> create an similiar table like this for how contribute the most cost, profit, sell order.
> [Image #2]

Then, while the plan was being drafted, on the brush close-up:

> i like the way how it seelect time rang
> [Image #3]

## Context

The desktop dashboard (`GET /api/dashboard`, `routes/dashboard.ts`,
`pages/desktop/DesktopDashboard.tsx`) has had the same four-button range
control since the first release: `7d | 30d | 90d | YTD`, sent as `?range=`
and mapped to rolling `NOW() - N days` windows.  `ytd` was really 365
rolling days.  Nothing accepts an explicit start and end date, and no
screen in the app has a date input.  The chart was a profit-only weekly
area chart labelled by ISO week number, under a "Tracking up" chip that
never said anything else.  The contributor leaderboard (RS-051, v1.141.0)
ranks purchasers only; no supplier or customer dimension exists anywhere on
the dashboard.

Mercury's page does three things this dashboard did not: the window is
chosen on a month strip by dragging, to the day, with the exact date shown
under the handle; the chart shows money in above the baseline and money out
below it; and two tables say who the money came from and went to, with a
% of total bar and a "remaining" row.

Decisions taken with Jinhu while planning (2026-09-17): three tables — Cost,
Sell orders, Profit — each with dimension tabs (Supplier | Purchaser |
Category for cost; Customer | Purchaser | Category for the sale side;
purchasers get Supplier | Category only, keeping the PRD §6.8 peer-money
mask); the chart becomes revenue up / cost down / profit line with
day/week/month buckets; the range is not persisted (the RS-051 call); the
phone dashboard keeps its 30-day view.

Definitions, so that every figure that shares a name shares a meaning:

- The business time zone is `America/Denver`.  `from`/`to` are calendar
  dates in it; a window is `[from 00:00, to + 1 day 00:00)`.  The previous
  window is the same length ending the day before `from`.
- **Cost** is the PO header total — goods (`total_cost`, or the line goods
  subtotal when the header is NULL) plus other fees — over Ready-to-Pay and
  Done POs by `created_at`, the leaderboard's rule.  Mercury's "Money out"
  is spend, not cost of goods sold.  The category split groups on the
  derived header category, so a mixed PO shows as "Mixed" and the three
  tabs sum to the same total.
- **Sell orders** is revenue of Done sell orders by `updated_at`, through the
  same `sell_order_lines → order_lines → orders` join the revenue tile uses,
  so a line with no inventory link is excluded exactly as the tile excludes
  it.  **Profit** is the gross-profit tile's figure over the same rows.
- Buckets are day (span ≤ 42 days), week (≤ 210) or month, overridable, and
  are clipped to the window so the chart sums to the tiles.

## Acceptance criteria

- [x] `GET /api/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD` scopes every figure
      to that inclusive window in the business time zone; `?range=` presets
      still work; `range=ytd` means since 1 January; a malformed or inverted
      `from`/`to` is a 400.
- [x] The response carries `window`, `bounds.first`, `series` (bucketed
      revenue / cost / profit — `weeks` is gone) and `contrib`.
- [x] Desktop: a range chip opens presets and custom dates; a month strip
      under the page head lets you drag a day-precise window, move it, and
      resize it by handle, with the date under the handle while dragging and
      the range label inside the band.
- [x] Chart: revenue up, cost down, profit line, a legend, a crosshair
      tooltip, a Day / Week / Month control; the series' revenue and profit
      sum to the KPI tiles and its cost to the Cost card for the same window.
- [x] Three contribution cards (Cost, Sell orders, Profit): dimension tabs,
      the top 7 rows with a % of total bar and the amount, a "Remaining N …"
      row; the tabs of one card share one total; the Sell orders total equals
      the revenue tile and the Profit total equals the gross-profit tile.
- [x] Purchaser lens: own POs only, Supplier | Category dimensions only, peer
      money never sent.
- [x] Phone dashboard unchanged apart from its sparkline reading `series`.
- [x] `en` and `zh` strings are in parity.

## Out of scope

- Persisting the range — the RS-051 call; the brush makes re-selecting a
  two-second job and a saved absolute range goes stale.
- A range control on the phone.
- Mercury's "Compare to" overlay, its saved views / export bar, and the AI
  insight sentences on its left rail.
- Moving the sale date from `sell_orders.updated_at` (a generic mtime) to the
  Done transition timestamp — the KPIs already use it; a separate ticket.
- Counting sell lines with no inventory link in revenue — the revenue tile's
  inner join excludes them today and the card matches the tile; a separate
  ticket if the tile is wrong.
- Excluding archived POs from the dashboard — no dashboard query does
  (RS-051).

## Notes

- Reference screenshots live in `docs/tickets/assets/RS-nnn-*.png`, a
  convention started with this ticket.
- The chart's down-bars are PO spend rather than cost of goods sold so that
  "cost" means one thing on the screen; the profit line is the realized
  gross profit, so it is not revenue minus the bars, and the card subtitle
  says so.
