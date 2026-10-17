---
id: RS-271
title: Fleet fold shows only today's searched cities in green
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-city-searched
pr: 685
version: 1.271.0
related: []
---

## Ask

> update the ui here.
> Only searched cities will show green. otherwsie it will still show grey.

(Screenshot: the Fleet tab's row fold for mw-1, "Searches 25 cities", every
chip green while the worker was 11/50 searches into its day.)

## Context

The fold in `apps/frontend/src/pages/desktop/FleetWorkers.tsx` colored every
city chip by the worker's status: all green when live or stale, all grey
otherwise. Nothing recorded which cities had been searched. The monitor walks
item → city → phrase and reported only funnel counts to
`/v1/stats/reviews`, so the coordinator knew "11 of 50", never which cities.
The requester chose exact per-city reporting over inferring the cities from
that count.

## Acceptance criteria

- [x] The monitor sends the search page's `search_city` with each funnel report.
- [x] The coordinator keeps the latest search time per (worker, city) and serves it to admins at `/v1/stats/search-cities`.
- [x] rs_console's `/v1/fleet` carries `today.cities`: the slugs searched in the worker's local day, null against an older coordinator.
- [x] On the Fleet fold and the worker page a chip is green only when its slug is in `today.cities`. Every other chip is grey, whatever the worker's status.

## Out of scope

- Inferring cities from the search count. A mid-day restart, a second run or several items would put it off.
- Per-phrase or per-item progress within a city, and counts per city.

## Notes

- One row per worker × city (`search_cities`), so the table stays bounded without pruning.
- The monitor change is a commit on the vendored fork's `recycle-patches` branch, pinned in `trackers/facebook/VENDOR.md`.
