---
id: RS-277
title: Busy cities searched more often — tiered daily city frequency
type: story
status: done
priority: P2
created: 2026-10-17
reporter: jinhu
branch: feat/fleet-city-tiers
pr: "#700"
version: 1.274.0
related: [RS-271, RS-275, RS-276]
---

## Ask

> 1. Update the facebook tracker infra and see how to enable the dynamic cities search instead of using the configuration files.i hope we can also edit dynamic.  The long term goal is for some popular cities, we can search more time days.
>
> Like top 20% of cities, we can search 3 times a day, top 40%, we can search 2 time and remainig search once a day.

## Context

Every worker walks every city of its list once per `start_at` time
(`start_at = ["10:00"]`), so a city that produced half the week's alerts
gets the same one search a day as one that never did. RS-275 (v1.272.0,
facebook-tracker 0.7.0) already made each worker's *list* of cities editable
from the ERP (console `PUT /v1/workers/{id}/cities`, written into that
worker's config). What is missing is the frequency.

The signal already exists: every alert the monitor sends to Telegram is
recorded in `alert_messages` with its `search_city` slug, and partner
reactions join to it (`ALERT_HIT_SQL`); the ERP shows those counts on the city
chips today.

A config rewrite is the wrong channel for something that changes daily: the
monitor hashes its config between jobs and restarts them — with an immediate
full sweep — on any change. So the tier is asked at search time instead.

## Acceptance criteria

- [x] The coordinator ranks a worker's cities by alerts sent + alerts reacted to over a window (default 30 days); the top 20% are searched 3×/day, the next 20% 2×/day, the rest 1×/day. A city with no alerts in the window is never promoted.
- [x] A city can be pinned to 3×, 2× or 1× regardless of its rank; percentages, per-day counts and window are editable.
- [x] A worker running `start_at` with N daily times searches, at each time, only the cities due in that slot; an N-per-day city is spread evenly over the slots, and 1×/day cities are spread across slots by a stable hash so no slot carries them all.
- [x] A worker that cannot reach the coordinator, or runs interval pacing instead of `start_at`, searches every city as before. With one `start_at` time, behaviour is unchanged.
- [x] The ERP's Edit cities dialog shows each city's alerts in the window, its frequency and whether it is pinned, and can pin; the fleet's city chips mark 3× and 2× cities; a manager can edit the tier settings.

## Out of scope

- Moving cities' storage out of the worker configs into a database — RS-275's per-worker lists stay the source of the list; only the frequency is dynamic.
- Ranking on anything other than alerts and reactions (listing volume, sale value).
- Per-item or per-phrase frequency.

## Notes

- Design, decided after RS-275 landed mid-session (the approved plan had a
  coordinator `cities` table; the user agreed to build on RS-275's
  per-worker lists instead):
  - Coordinator owns the ranking and the plan: `POST /v1/workers/{id}/search-plan`
    (worker token) takes the worker's config cities and the slot it is in, and
    returns the cities to search. Stateless with respect to `search_cities.last_at`,
    so several items in one slot all get the same list.
  - Admin: `GET/PUT /v1/city-tiers` (settings + pins), `POST /v1/city-tiers/rank`
    (the console annotates `/v1/fleet` with it).
  - The console proxies those to the ERP; the ERP edits them.
- Taking it to 3×/2×/1× needs three `start_at` times (e.g. 02:00, 10:00,
  18:00 UTC), set from the existing search settings form. Expected load ≈1.6×
  today's searches.
- Monitor fork commits on `recycle-patches`; the deployed fork lives in
  `~/Projects/recycle_servers/facebook_tracker/ai-marketplace-monitor`, not the
  monorepo checkout's copy, which is behind the `VENDOR.md` pin.
- Shipped with facebook-tracker v0.8.0 (fork `3d6dc96`), deployed 2026-10-17:
  coordinator, console and all ten workers rebuilt. `deploy.sh` recreates only
  `rs-monitor`; the coordinator, console and the nine `rs-monitor-*` workers were
  rebuilt by hand. Tiers take effect once the search settings list 2+ start times.
