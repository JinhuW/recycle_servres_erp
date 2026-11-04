---
id: RS-525
title: Keep performance evidence by route and release
type: story
status: done
priority: P2
created: 2026-11-04
reporter: jinhu
branch: JinhuW/foxface
pr: 1084
version: 1.418.0
related: []
---

## Ask

> Add an approach to track the performance of the system and provide some evidence for future optimization.

## Context

The ERP emitted timing but kept none of it in a form that could answer "what should we optimize, and did the last change help?":

- The Prometheus histogram in `metrics.ts` resets on every deploy, and `/metrics` answers 404 through the prod Worker. No scraper config lives in this repo; the homelab's config lives elsewhere, so one there was not ruled out.
- The `request` log line carries raw paths and no aggregation, at about 100k lines a day.
- The `client timing` log line (`routes/clientTimings.ts`) did not say which page or shell it came from, and nothing computed percentiles from it.
- Railway's HTTP metrics are whole-service unless queried one path at a time, with a 7-day window. Railway tracing is off on every prod service.

Prod on 2026-11-04, read-only: 730,715 requests in 7 days, daily p50 27–39 ms, p90 58–104 ms. p95 sat at exactly 30,000 ms on three days and p99 on six, and that view could not say which routes caused it. A 60-row sample of requests over 20 s was mostly long-lived VNC websockets, plus some fleet `heartbeat`, `session` and host `report` calls ending in 499 after 32–110 s. That sample is a lead, not a finding. Page loads (latest 201 reports, 1–4 Nov): LCP p50 588 ms, p75 1,276 ms, p95 2,440 ms; API calls per load p50 9, p95 20.

## Acceptance criteria

- [x] Requests are recorded hourly per route and release, and survive a deploy
- [x] Route labels stay parameterized: `/api/orders/:id`, never a real id
- [x] A failed flush loses no counts, and a flush failure never fails a request
- [x] Client reports carry shell and allowlisted page. An unknown page is stored as `other`
- [x] Rollups hold no user identity, ids or raw paths
- [x] Non-managers get 403 from all `/api/perf/*` routes
- [x] A manager can see slowest routes, page loads and a two-version compare in Settings
- [x] A VNC socket's lifetime does not appear in the route data, only its short authorization request

## Out of scope

- Tracker performance. They have their own stacks.
- Alerting on regressions.
- Railway tracing and homelab Prometheus scraping.
- Per-query timing. `pg_stat_statements` has to go in `shared_preload_libraries`, which restarts the prod database, so it waits until route data shows SQL is the bottleneck and the owner agrees.
- Fixing anything the data reveals.

## Notes

- Histograms rather than stored percentiles, because percentiles cannot be merged across hours or releases. Percentiles read back are estimates only as fine as the bucket bounds, and the panel says so.
- `page` reuses `pathToDesktopView`, which is already a closed set, and the backend allows only `PERF_PAGES`. A frontend test fails if a view is added without being listed.
- The VNC bridge replays each upgrade through the app to authorize it, so that replay does appear, as a short request. The original criterion said websockets would not appear at all.
- bfcache restores and prerenders stay out of the rollups, but stay in the log line.
- SPA route changes are not measured, as before: one report per full page load.
- Verified locally against real browser traffic, with two releases simulated through `APP_VERSION`. Both the 60 s flush and the shutdown flush were exercised.
- Prod evidence starts only after a release to `main`.
