---
id: RS-067
title: Dashboard drops the contributor leaderboard
type: task
status: done
priority: P3
created: 2026-09-17
reporter: jinhu
branch: chore/dashboard-no-leaderboard
pr: 351
version: 1.149.3
related: [RS-062, RS-059, RS-061]
---

## Ask

With a screenshot of the desktop Dashboard's "Contributor leaderboard" card
(sub-line "Ranked by total cost paid · all item types", a Total cost /
Commission toggle, an All / RAM / SSD / HDD / Other toggle, and columns #,
Contributor, Orders, Total cost, Revenue, Profit, Commission), sent while
RS-064 was in progress:

> also remove this table

The screenshot was pasted inline and is not on disk.

## Context

The desktop Dashboard has ranked purchasers in a full-width table since
v1.0.1. The same request shape as RS-062 (v1.147.2), which dropped the
Purchase orders page's KPI strip: since RS-059 and RS-061 the tiles, the
cashflow chart and the contribution cards state the team's figures with a
reporting window, and the leaderboard repeated them per purchaser under a
narrower rule (POs counted from Ready to Pay). Removing it leaves the
contribution cards followed directly by recent activity.

The desktop card only. The phone dashboard's "Top contributors" (manager)
and "Your rank" (purchaser) cards read the same `leaderboard` field and
were not in the screenshot; they and the API stay.

## Acceptance criteria

- [ ] The desktop Dashboard renders no leaderboard card and sends no `lb`
      query parameter; tiles, chart, category breakdown, contribution cards
      and recent activity are unchanged.
- [ ] The manager subtitle no longer promises a "contributor ranking".
- [ ] The phone Dashboard is unchanged.
- [ ] No dead i18n keys are left behind; `en` and `zh` in parity.
- [ ] `GET /api/dashboard` is unchanged.

## Out of scope

- The phone dashboard's ranking cards and the `leaderboard` API field.
- CSS: `.lb-scroll` (FX rate history uses it) and `.lb-rank` (phone cards,
  order review) stay.
