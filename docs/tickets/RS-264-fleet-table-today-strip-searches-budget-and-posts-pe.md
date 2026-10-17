---
id: RS-264
title: Fleet table: Today strip, Searches budget and Posts per worker
type: story
status: in-progress
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-today-posts-searches
pr:
version:
related: [RS-261, RS-262, RS-263]
---

## Ask

> The current fleet page is missing
> [Image #1]
> today + Posts + Searches.
>
> /goal
>
> make up both frontend and backend

(Image #1: the designed Fleet table with the columns Today 今天 — a day strip
with the sweep window, a now tick and "07:25–now, ≈15:24 · 13:40 MT";
Searches 搜索 — a ring with "31/40"; Session; Posts 新帖 — "23 new / 4 alerts ·
7 d"; and the summary "100 new posts today · 29 alerts this week · 18 of 47
metros covered". The fold's pacing line reads "45–75 min between repeats ·
fleet default · 8 phrases × 5 metros = 40 searches a day".)

## Context

RS-261 (v1.263.0) shipped the Fleet tab on real data and listed "per-worker
searches and budget, and the day strip of a sweep" as phase 2, because the
coordinator kept none of it. What it had, confirmed against the monitor source
on the VM (`ai-marketplace-monitor` `recycle-patches`):

- `report_search_heartbeat` stamps `last_search_at` once per **item** at the
  top of `search()`, then `search()` loops cities × phrases. The 5-minute
  repeater re-sends the same stamp, so only a new stamp is a new cycle.
- RS-262 (v1.264.0, merged while this was in progress) made workers count
  every funnel stage — `searches` (one per search page, i.e. one phrase in one
  city), `reviewed`, `alerted`, … — into `review_stats`, one row per worker
  per UTC day. The admin read only served fleet-wide sums.
- `start_at` in `master.toml` (`["10:00"]` UTC) is the daily sweep schedule.

## Acceptance criteria

- [x] Coordinator: a `search_cycles` table. A heartbeat whose `last_search_at`
      differs from the stored one logs a row (with the item). Rows older than
      14 days are pruned.
- [x] Coordinator: admin `GET /v1/stats/search-cycles?hours=` and
      `GET /v1/stats/reviews/workers?days=` (every counter per worker per UTC
      day, with `updated_at`).
- [x] Console `/v1/fleet`: each worker carries `timezone` (from its region),
      `plan` (phrases, cities, runs per day, searches per day) and `today`
      (local day, first and last activity, cycles, searches — null when no
      search was counted for it in two days — posts and alerts).
      `search.start_at` is exposed. No new route reaches the ERP.
- [x] ERP Fleet table: Today (a 24-hour local strip with the searched window,
      the now tick, an ETA tail while a sweep runs, the next scheduled start,
      hatching for an offline or attention worker, and "start–end · local
      time TZ"), Searches (a ring, done / per-day budget; amber when the budget
      is met, "—" when nothing is counted), Session, Posts ("N new" and "N
      alerts · 7 d"). The Last search and Alerts columns fold into Today and
      Posts.
- [x] The summary line adds "N new posts today"; the fold adds "P phrases × C
      cities = N searches a day".
- [x] Every new string has English and Chinese.

## Out of scope

- Pause (the design's hatched "paused" row): the fleet has no pause. Hatching
  marks an offline or needs-attention worker instead.
- "N of M metros covered": coverage gaps need the region-gap check from
  `rsc gen-configs`, not a count.
- Deploying the tracker. The ERP release reads the new fields when they are
  there and shows "—" until the coordinator and console are deployed with
  `scripts/deploy.sh`.

## Notes

- The first build added its own per-search endpoint (`POST
  /v1/stats/searches`) and a vendored-monitor change to call it. RS-262 landed
  the same count through the funnel report first, so that endpoint was
  dropped and Searches reads `review_stats.searches`; only cycle starts are
  new data.
- "Posts" is `reviewed` (listings the AI saw for the first time), not `fresh`:
  `fresh` counts every not-yet-alerted listing on each sweep, so a listing
  lingering for a week would be "new" seven times.
- Counters are per UTC day; the row dated with the worker's local date holds
  its sweep, because the 10:00 UTC sweep runs inside UTC daytime in every US
  zone.
- Local verification exposed that the coordinator, started from an ERP shell,
  inherits the ERP's `DATABASE_URL` and writes into `recycle-erp-testdb`. That
  is now in `trackers/facebook/AGENTS.md`.
