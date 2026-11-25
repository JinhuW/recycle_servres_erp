---
id: RS-615
title: Expose performance as Prometheus metrics instead of in the ERP
type: story
status: done
priority: P2
created: 2026-11-24
reporter: jinhu
branch: JinhuW/prometheus-perf
pr: 1261
version: 1.482.0
related: [RS-525]
---

## Ask

> for the performance i hope you can epxose an prometheus metrics instead of in the EPR system .

## Context

RS-525 (v1.418.0) kept performance evidence inside the ERP: `lib/perf.ts` wrote
hourly histograms to `perf_rollups`, `/api/perf/*` read them back, and
Settings ▸ Performance showed them. The backend already served prom-client
metrics at `/metrics` (`http_request_duration_seconds`, `http_requests_total`,
labelled by Hono's `routePath`), but prod could not be scraped: the Worker
forwards only `/api`, `/oauth` and `/.well-known`, so `/metrics` answered 404,
and the Railway origin refuses anything without `PROXY_SECRET`.

The homelab Prometheus (`10.10.60.5:9090`, 15 d retention) had no live ERP
target. Its `recycle-erp-backend` job in `JinhuW/homelab-monitoring` still
pointed at the pre-Railway host. The `recycle-erp` Grafana dashboard already
queries the two `http_*` series, so their names stay. Page-load timings went
only to the rollups and a log line.

## Acceptance criteria

- [x] `GET /metrics` through the Worker returns Prometheus text with `Authorization: Bearer $METRICS_TOKEN`, 401 without it or with a wrong one, and 404 in production when `METRICS_TOKEN` is unset
- [x] Every series carries a `release` label, so two releases can be compared in PromQL
- [x] Page loads are histograms `web_page_load_seconds`, `web_page_lcp_seconds` and `web_page_ttfb_seconds`, labelled `shell` and `page` from closed sets (unknown page → `other`), counting only `navigate` and `reload` loads
- [x] Route labels stay parameterized
- [x] `perf_rollups`, `/api/perf/*`, Settings ▸ Performance and the flush loop are gone, and a migration drops the table
- [x] The homelab Prometheus scrapes the ERP and the `recycle-erp` dashboard shows data

## Out of scope

- Alerting rules.
- Retention beyond the homelab's 15 days. The rollups kept 400 days.
- Per-query SQL timing.
- The trackers.

## Notes

- One backend instance serves prod (the VNC relay lease depends on it), so a scrape through the Worker always reaches the same process.
- Counters reset on each deploy. `rate()` and `increase()` handle that, and the `release` label marks the boundary.
