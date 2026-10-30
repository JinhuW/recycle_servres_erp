---
id: RS-462
title: Reddit analytics: missed-lead tables in their own card, sortable, height-capped
type: story
status: backlog
priority: P3
created: 2026-10-29
reporter: jinhu
branch: JinhuW/rs-tracker-missed-leads
pr:
version:
related: []
---

## Ask

> Update the ui
>
> /frontend-design
> [Image #1]
> [Image #2]
> [Image #3]
>
> put them in a seperate section for this missing information.
> Sortable table. cap hight.

[screenshots: Monitors ▸ Reddit ▸ Analytics — the "Missing: memory posts with
5+ PMs and no good-catch reaction" table, the "By subreddit" table, and the
"Other posts buyers wanted (25), not memory" table]

## Context

`AnalyticsCard` (`apps/frontend/src/pages/desktop/TrackerAnalytics.tsx`) put
the tiles, chart, PM demand, prompt table and the three missing-lead tables in
one card. The missing table's rows run three or four lines each (the prompt's
reason), so it pushed everything after it far down the page, and none of the
tables sorted.

## Acceptance criteria

- [x] The missing posts, By subreddit and Other posts buyers wanted tables sit
      in their own card, Missed leads, under How the tracker is doing, driven
      by the same window and data.
- [x] Its head says the window and shows "N of M missing".
- [x] Each column title in those tables sorts (desc → asc → the tracker's
      order), except the free-text reason column; the subreddit is its own
      sortable column on the post tables.
- [x] Each of the three tables stops at 520px and scrolls under a pinned
      header.

## Out of scope

The prompt-version table stays in the first card, unsorted. No API change.

## Notes

Sort uses `components/SortTh` and the in-memory `usePersisted`, like the
Fleet tables, so a sort survives leaving the tab within a page load.
