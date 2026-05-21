# System metrics sidecar — design

**Status:** approved
**Date:** 2026-05-21
**Author:** Claude (Recycle ERP)

## Goal

Expose application-level and Postgres-level metrics from this host so the
existing Grafana stack at `https://grafana.jinhu.us/` (which also hosts the
Prometheus that does the scraping) can build dashboards over them.

The remote Prometheus and Grafana run on the same host. That host reaches
this host over an internal LAN; the network is trusted. No DNS, TLS, or
auth is required on our side.

## Non-goals

- Host system metrics (node_exporter, load average, disk space). Out of
  scope by user decision.
- Per-container metrics (cAdvisor).
- Alertmanager rules, recording rules, dashboard JSON. Those live on the
  Grafana host, not in this repo.
- A local TSDB. The remote Prometheus stores everything.

## Architecture

```
┌────────── this host ────────────────────────────────────────────┐
│                                                                  │
│  remote Prometheus ──► host port 9090 (Caddy, all interfaces)    │
│  (grafana.jinhu.us)      ├─ /metrics/backend  → backend:8787     │
│                          └─ /metrics/postgres → pg_exp:9187      │
│                                                                  │
│  compose internal net:                                           │
│     backend     ── prom-client + /metrics route                  │
│     postgres-exporter ── connects to postgres:5432 as `metrics`  │
│     postgres                                                     │
└──────────────────────────────────────────────────────────────────┘
```

Three changes on this side:

1. New compose sidecar: `postgres-exporter`.
2. New listener in the existing Caddy: `:9090` with two path-based
   reverse-proxy routes. One new host port mapping (`9090:9090`).
3. Backend gets a `prom-client`-backed `/metrics` route plus an HTTP
   middleware that records request duration.

Plus one database migration that adds a read-only `metrics` role.

## Components

### postgres-exporter

- Image: `quay.io/prometheuscommunity/postgres-exporter:v0.15.0`.
- Connects as `metrics` Postgres role (created by migration 0042) using
  `pg_monitor` privileges only — no DML, no DDL, no read access to user
  tables.
- Listens on `:9187/metrics` on the compose internal network. Not
  host-published; reached only via Caddy.
- Hardening (project convention — same block as every other service):
  - `cap_drop: ALL`
  - `security_opt: no-new-privileges:true`
  - `mem_limit: 64m`
  - JSON-file log rotation (`max-size: 50m`, `max-file: 5`)
- Connection string uses compose hostname `postgres:5432`. Password
  comes from `POSTGRES_METRICS_PASSWORD` env var with a dev default of
  `metrics`, mirroring the `POSTGRES_PASSWORD` convention.

### Caddy `:9090` listener

Added to `apps/frontend/Caddyfile` as a second site block beside the
existing `:80` block:

```
:9090 {
  encode gzip
  handle_path /metrics/backend {
    rewrite * /metrics
    reverse_proxy backend:8787
  }
  handle_path /metrics/postgres {
    rewrite * /metrics
    reverse_proxy postgres-exporter:9187
  }
  respond 404
}
```

- `handle_path` strips the prefix so only `/metrics` reaches each
  upstream. The backend's API and the exporter's other routes are not
  reachable through this listener.
- Compose adds `"9090:9090"` to the `web` service's `ports`. All
  interfaces; LAN is trusted.
- The same Caddy process serves both the SPA on `:80` and metrics on
  `:9090`. The `mem_limit: 256m` on the `web` service stays unchanged —
  Caddy's per-vhost cost is negligible.

### Backend `/metrics` route

- New file `apps/backend/src/metrics.ts`. Owns:
  - A single `prom-client` `Registry`.
  - Default Node.js metrics collection (`collectDefaultMetrics`).
  - Custom metrics:
    - `http_request_duration_seconds` — histogram, labels
      `{method, route, status}`. Route is the Hono matched-pattern, not
      the raw path, so cardinality stays bounded.
    - `http_requests_total` — counter, same labels.
    - `ocr_calls_total` — counter, labels `{provider, outcome}`.
    - `order_state_transitions_total` — counter, labels
      `{order_type, from, to}`.
  - An exported `metricsMiddleware` that times every request via
    `c.req.routePath`.
  - An exported `metricsRoute(c)` that returns `register.metrics()` as
    `text/plain; version=0.0.4; charset=utf-8`.
- New dependency: `prom-client@^15` in `apps/backend/package.json`.
- Wiring in `apps/backend/src/index.ts`:
  - `/metrics` route is registered **before** the `dbScope` middleware
    is applied. A scrape every 15s would otherwise pull a fresh Postgres
    client out of the pool for no reason. Concretely: register the
    route immediately after the request-id middleware and CORS, before
    `csrfGuard` and `dbScope`.
  - The `metricsMiddleware` is mounted at `app.use('*', ...)` after
    `logger()` and CORS, before `csrfGuard`. It must observe every
    request that reaches the handler (including 4xx/5xx) so the
    histogram reflects reality.
  - Emit `ocr_calls_total` from `apps/backend/src/ai/` after each OCR
    invocation, with `outcome` in `{ok, error, stub}`.
  - Emit `order_state_transitions_total` from the existing status-guard
    helpers in `routes/orders.ts`, `routes/sellOrders.ts`,
    `routes/inventory.ts`, `routes/vendorBids.ts`.

### Migration 0042 — metrics role

`apps/backend/migrations/0042_metrics_role.sql`:

```sql
-- Read-only role for the postgres-exporter sidecar.
-- Granted pg_monitor only: pg_read_all_settings + pg_read_all_stats +
-- pg_stat_scan_tables. No SELECT on user tables, no DML, no DDL.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrics') THEN
    CREATE ROLE metrics LOGIN PASSWORD 'metrics';
  END IF;
END $$;

GRANT pg_monitor TO metrics;
```

The literal `'metrics'` password matches the dev default; production
overrides via `POSTGRES_METRICS_PASSWORD`. Out-of-tree like
`POSTGRES_PASSWORD` already is.

## Data flow

The remote Prometheus polls each target at its configured cadence
(default 15s):

```
GET http://<this-host>:9090/metrics/backend
GET http://<this-host>:9090/metrics/postgres
```

Each call:

1. Hits Caddy on `:9090`.
2. Caddy strips the path prefix and proxies to either `backend:8787` or
   `postgres-exporter:9187` over the compose net.
3. The upstream returns Prometheus exposition format.
4. Caddy gzips and returns.

Scrape latency budget per target: under 100ms locally; the round-trip
cost is dominated by LAN latency, not the upstream.

## Security & hardening

- `:9090` bound to all interfaces. To tighten later, change the compose
  port mapping to `<internal-ip>:9090:9090`.
- The `metrics` Postgres role is `pg_monitor`-only. It cannot read any
  user-data table, cannot mutate anything, and cannot enumerate
  application schema beyond what `pg_catalog` exposes.
- The new sidecar inherits the project convention: `cap_drop: ALL`,
  `no-new-privileges:true`, `mem_limit`, JSON log rotation.
- The backend's `/metrics` route is path-distinct from `/api/*`, so the
  existing frontend Caddy on `:80` never proxies metrics to a browser.
  The route is unauthenticated by design (Prometheus scrapers don't
  carry JWTs).

## Testing

- Backend integration test (`apps/backend/tests/metrics.test.ts`):
  - Hits `/metrics`, asserts 200, content-type `text/plain`, body
    contains `process_resident_memory_bytes` (proves default metrics
    are wired) and `http_request_duration_seconds` (proves the
    middleware ran).
  - Makes a few requests against another route first to populate the
    histogram, then re-scrapes and asserts the counter incremented.
- Manual verification post-deploy:
  - `curl http://localhost:9090/metrics/backend` returns a Prometheus
    exposition.
  - `curl http://localhost:9090/metrics/postgres` returns
    `pg_up 1` and `pg_stat_database_*`.
- Deploy runbook gets one new step: scrape both targets once before
  declaring the deploy healthy.

## Risks & decisions

- **Route cardinality.** Labeling `http_request_duration_seconds` with
  the raw URL path would blow up cardinality (every order ID becomes a
  new label combination). We use Hono's matched-pattern instead.
- **Backend `/metrics` opening DB connections.** Mitigated by
  registering the route before `dbScope` so scrapes never touch the
  pool.
- **Metrics role password leakage.** The dev default is fine; prod
  needs `POSTGRES_METRICS_PASSWORD` set out-of-tree, same way
  `POSTGRES_PASSWORD` is handled today.
- **Bind-everywhere on `:9090`.** Accepted because the LAN is trusted
  and there is no application data on the metrics endpoint. Documented
  for future tightening.
- **No alerting on this side.** Alert rules belong on the remote
  Prometheus, where Alertmanager is presumably already wired.

## File-level deltas

- `docker-compose.yml` — add `postgres-exporter` service; add
  `"9090:9090"` to `web.ports`.
- `apps/frontend/Caddyfile` — add `:9090` site block.
- `apps/backend/package.json` — add `prom-client@^15`.
- `apps/backend/src/metrics.ts` — new file.
- `apps/backend/src/index.ts` — register route + middleware in the
  correct order.
- `apps/backend/src/ai/index.ts` (or per-provider file) — emit
  `ocr_calls_total`.
- `apps/backend/src/routes/orders.ts`,
  `apps/backend/src/routes/sellOrders.ts`,
  `apps/backend/src/routes/inventory.ts`,
  `apps/backend/src/routes/vendorBids.ts` — emit
  `order_state_transitions_total` from the existing transition guards.
- `apps/backend/migrations/0042_metrics_role.sql` — new migration.
- `apps/backend/tests/metrics.test.ts` — new test.
- `apps/backend/.env.example` — document `POSTGRES_METRICS_PASSWORD`.
- `README.md` — short ops section: scrape URLs and how to add the two
  jobs to a Prometheus config.
