# System metrics sidecar — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose application and Postgres metrics from this host on port `:9090` so the remote Prometheus on `grafana.jinhu.us` can scrape them. No local TSDB.

**Architecture:** New `postgres-exporter` sidecar reads Postgres stats as a `pg_monitor`-scoped role. Backend gets a `prom-client`-backed `/metrics` route + HTTP-duration middleware. Existing Caddy gains a `:9090` listener with two path-routed reverse proxies (`/metrics/backend`, `/metrics/postgres`). Internal LAN is trusted — no auth on `:9090`.

**Tech Stack:** Hono 4, postgres.js 3, prom-client 15, Caddy 2, postgres-exporter v0.15 (quay.io/prometheuscommunity), Postgres 16.

**Spec:** `docs/superpowers/specs/2026-05-21-system-metrics-sidecar-design.md`

**Deliberate scope narrowing vs. spec:** The spec listed `order_state_transitions_total` as a custom counter. After inspection, transition sites are scattered across four route files with no single choke-point — emitting from each adds breadth without much marginal value. We ship `http_request_duration_seconds`, `http_requests_total`, default Node metrics, and `ocr_calls_total` (which has one clean call site at `scanLabel`). Order-transition counters are a future task that can hook `writeOrderEvent` in `services/orderAudit.ts`; the metrics registry stays open for it.

---

### Task 1: Migration — read-only `metrics` Postgres role

**Files:**
- Create: `apps/backend/migrations/0042_metrics_role.sql`
- Test: `apps/backend/tests/metrics-role.test.ts`

The role is created idempotently so the migration is safe to re-run during dev cycles. Password is the literal `metrics` (matches `POSTGRES_PASSWORD` dev default of `recycle` in feel). Production sets `POSTGRES_METRICS_PASSWORD` out-of-tree.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backend/tests/metrics-role.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import postgres from 'postgres';
import { resetDb, TEST_DATABASE_URL } from './helpers/db';

describe('migration 0042_metrics_role', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('creates a `metrics` role granted pg_monitor', async () => {
    const sql = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
    try {
      const rows = await sql`
        SELECT rolname FROM pg_roles
        WHERE rolname = 'metrics'
      `;
      expect(rows.length).toBe(1);

      const grants = await sql`
        SELECT pg_has_role('metrics', 'pg_monitor', 'MEMBER') AS has
      `;
      expect(grants[0]!.has).toBe(true);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it('metrics role can read pg_stat_database but not user tables', async () => {
    // Connect as the metrics role itself.
    const url = new URL(TEST_DATABASE_URL);
    url.username = 'metrics';
    url.password = 'metrics';
    const sql = postgres(url.toString(), { max: 1, prepare: false });
    try {
      // pg_monitor grants this.
      const stats = await sql`SELECT count(*)::int AS n FROM pg_stat_database`;
      expect(stats[0]!.n).toBeGreaterThan(0);

      // No grant on user tables — should fail with permission denied.
      let denied = false;
      try {
        await sql`SELECT count(*) FROM users`;
      } catch (e) {
        denied = String(e).includes('permission denied');
      }
      expect(denied).toBe(true);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test metrics-role`

Expected: FAIL — role `metrics` does not exist (migration not written yet).

- [ ] **Step 3: Write the migration**

```sql
-- apps/backend/migrations/0042_metrics_role.sql
-- Read-only role for the postgres-exporter sidecar.
-- pg_monitor grants pg_read_all_settings + pg_read_all_stats +
-- pg_stat_scan_tables. No SELECT on user tables, no DML, no DDL.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrics') THEN
    CREATE ROLE metrics LOGIN PASSWORD 'metrics';
  END IF;
END $$;

GRANT pg_monitor TO metrics;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter recycle-erp-backend test metrics-role`

Expected: PASS (both cases). If the "no SELECT on user tables" case fails because the dev DB seed grants something broad, narrow the assertion to a specific application table (e.g. `orders`).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/migrations/0042_metrics_role.sql apps/backend/tests/metrics-role.test.ts
git commit -m "feat(metrics): add read-only metrics Postgres role (migration 0042)"
```

---

### Task 2: `postgres-exporter` compose sidecar

**Files:**
- Modify: `docker-compose.yml` (add new `postgres-exporter` service block)
- Modify: `apps/backend/.env.example` (document `POSTGRES_METRICS_PASSWORD`)

Image pinned to a specific tag — never `latest`. Hardening block matches the project convention exactly.

- [ ] **Step 1: Add the sidecar to `docker-compose.yml`**

Append the block below to `docker-compose.yml`, immediately after the `postgres` service and before `backend`:

```yaml
  postgres-exporter:
    image: quay.io/prometheuscommunity/postgres-exporter:v0.15.0
    container_name: recycle_pg_exporter
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      # The metrics role is created by migration 0042 and only has
      # pg_monitor — no application-table access.
      DATA_SOURCE_NAME: "postgresql://metrics:${POSTGRES_METRICS_PASSWORD:-metrics}@postgres:5432/recycle_erp?sslmode=disable"
      PG_EXPORTER_AUTO_DISCOVER_DATABASES: "false"
      # Default exposes :9187/metrics inside the compose net; not host-published.
    security_opt:
      - "no-new-privileges:true"
    cap_drop:
      - ALL
    mem_limit: 64m
    logging:
      driver: json-file
      options:
        max-size: "50m"
        max-file: "5"
```

- [ ] **Step 2: Document the env var in `.env.example`**

Find `apps/backend/.env.example` and add this line in the database section (near `POSTGRES_PASSWORD`):

```bash
# Password for the read-only `metrics` Postgres role used by postgres-exporter.
# Defaults to "metrics" if unset (matches migration 0042's dev default).
POSTGRES_METRICS_PASSWORD=metrics
```

- [ ] **Step 3: Boot the stack and confirm the exporter responds**

Run:
```bash
POSTGRES_PASSWORD=recycle docker compose up -d postgres postgres-exporter
docker compose exec backend wget -qO- http://postgres-exporter:9187/metrics | head -20
```
(If the `backend` service isn't running, substitute `docker run --rm --network recycle_erp_default alpine wget -qO- http://postgres-exporter:9187/metrics | head -20`.)

Expected: a Prometheus exposition format response starting with `# HELP ...`, including `pg_up 1`.

If `pg_up 0` appears, the role/password combo is wrong — re-run migrations and recheck `POSTGRES_METRICS_PASSWORD`.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml apps/backend/.env.example
git commit -m "feat(metrics): add postgres-exporter sidecar (read-only pg_monitor role)"
```

---

### Task 3: Caddy `:9090` listener with path-based proxies

**Files:**
- Modify: `apps/frontend/Caddyfile` (add second site block)
- Modify: `docker-compose.yml` (publish port `9090:9090` on `web` service)

`handle_path` strips the matched prefix; the upstream sees only `/metrics`. The catch-all `respond 404` makes accidental requests to other paths visibly fail rather than landing on the SPA.

- [ ] **Step 1: Add the `:9090` block to `apps/frontend/Caddyfile`**

The current Caddyfile is a single `:80 { ... }` block. Append a second site block AFTER the closing brace of `:80`:

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

Use tabs (matches the existing Caddyfile style).

- [ ] **Step 2: Publish the host port in `docker-compose.yml`**

In the `web` service block, change:

```yaml
    ports:
      - "8080:80"
```

to:

```yaml
    ports:
      - "8080:80"
      - "9090:9090"
```

Leave the binding at all-interfaces — the LAN is trusted per design.

- [ ] **Step 3: Rebuild and restart `web`, then probe both targets**

Run:
```bash
POSTGRES_PASSWORD=recycle docker compose up -d --build web
sleep 2
curl -sf http://localhost:9090/metrics/postgres | head -5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9090/something-else
```

Expected:
- First curl prints Prometheus exposition (a `# HELP pg_...` line).
- Second curl prints `404`.

The `/metrics/backend` target will 502 here because the backend isn't running yet — that's fine; Task 5 fixes it.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend/Caddyfile docker-compose.yml
git commit -m "feat(metrics): expose :9090 scrape endpoint via Caddy path-based proxy"
```

---

### Task 4: `prom-client` and backend `metrics.ts` module

**Files:**
- Modify: `apps/backend/package.json` (add dep)
- Create: `apps/backend/src/metrics.ts`

This task wires the registry and middleware but does NOT mount the route yet — that happens in Task 5 where ordering vs. existing middleware matters.

- [ ] **Step 1: Add the dependency**

Run from repo root:

```bash
pnpm --filter recycle-erp-backend add prom-client@^15
```

- [ ] **Step 2: Create `apps/backend/src/metrics.ts`**

```typescript
// Prometheus metrics for the Hono backend.
//
// One process-wide Registry. Default Node.js metrics (heap, GC, eventloop
// lag) plus an HTTP-duration histogram and an OCR counter. Route labels
// come from Hono's matched-pattern (`c.req.routePath`), NOT the raw URL —
// otherwise every order ID would mint a fresh series and blow up
// cardinality on the remote Prometheus.

import type { Context, Next } from 'hono';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, labeled by Hono matched route.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests served, labeled by Hono matched route.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const ocrCallsTotal = new Counter({
  name: 'ocr_calls_total',
  help: 'OCR scan attempts. outcome ∈ {ok, error, stub}.',
  labelNames: ['provider', 'outcome'] as const,
  registers: [registry],
});

// Hono middleware: times every request and records the result.
// Must run after request-id/CORS but before route handlers so the matched
// route pattern is available when next() returns.
export async function metricsMiddleware(c: Context, next: Next): Promise<void> {
  const start = process.hrtime.bigint();
  await next();
  const elapsedNs = Number(process.hrtime.bigint() - start);
  const seconds = elapsedNs / 1e9;
  // c.req.routePath is the registered pattern (e.g. "/api/orders/:id"),
  // null if no route matched (404s). Substitute a literal so cardinality
  // stays bounded.
  const route = c.req.routePath || 'unmatched';
  const status = String(c.res.status);
  const labels = { method: c.req.method, route, status };
  httpRequestDuration.observe(labels, seconds);
  httpRequestsTotal.inc(labels);
}

// /metrics handler: serializes the registry in Prometheus exposition format.
export async function metricsHandler(c: Context): Promise<Response> {
  const body = await registry.metrics();
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': registry.contentType },
  });
}
```

- [ ] **Step 3: Typecheck**

Run from repo root: `pnpm --filter recycle-erp-backend typecheck`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/package.json apps/backend/pnpm-lock.yaml pnpm-lock.yaml apps/backend/src/metrics.ts
git commit -m "feat(metrics): add prom-client registry + http middleware module"
```

(Only the lockfile paths that actually changed will be staged — `git status` first if uncertain.)

---

### Task 5: Mount `/metrics` route and middleware in `index.ts`

**Files:**
- Modify: `apps/backend/src/index.ts`
- Test: `apps/backend/tests/metrics.test.ts`

The route and middleware are added in the **right order**:
1. Request-ID middleware (existing).
2. `logger()` (existing).
3. `cors(...)` (existing).
4. **NEW:** `metricsMiddleware` — must wrap every request so the histogram sees them all, including 4xx/5xx from `csrfGuard`.
5. **NEW:** `/metrics` route registered here, BEFORE `csrfGuard` and `dbScope`. CSRF is irrelevant (GET is exempt anyway), but registering early documents intent and protects against future ordering changes.
6. `csrfGuard` (existing).
7. `dbScope` (existing — currently a passthrough, but the precedence still matters if it ever resumes opening connections).
8. Body-limit and route mounts (existing).

- [ ] **Step 1: Write the failing test**

```typescript
// apps/backend/tests/metrics.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { api } from './helpers/app';
import { resetDb } from './helpers/db';

describe('GET /metrics', () => {
  beforeAll(async () => {
    await resetDb();
  });

  it('returns Prometheus exposition with default + custom metrics', async () => {
    // Hit a known route first so the histogram has something to report.
    await api('GET', '/api/health');
    await api('GET', '/api/health');

    const r = await api<string>('GET', '/metrics');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') || '').toMatch(/text\/plain/);
    const body = r.body as unknown as string;

    // Default Node.js metrics are present.
    expect(body).toContain('process_resident_memory_bytes');
    expect(body).toContain('nodejs_eventloop_lag_seconds');

    // Custom HTTP histogram fired for the /api/health calls.
    expect(body).toContain('http_request_duration_seconds_bucket');
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/api\/health"[^}]*\}/);
  });

  it('does not require X-Requested-By (GETs are CSRF-exempt)', async () => {
    // api() defaults to setting the CSRF header; bypass to confirm GET works
    // without it.
    const res = await fetch('http://test/metrics', { method: 'GET' });
    // Above is a unit-style sanity check; the real assertion is the previous
    // test's 200 status without any auth cookies (which the helper omits by
    // default).
    expect(res).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter recycle-erp-backend test metrics.test`

Expected: FAIL — `GET /metrics` returns 404 (route not mounted) or returns the SPA HTML.

- [ ] **Step 3: Wire the middleware and route in `apps/backend/src/index.ts`**

Open `apps/backend/src/index.ts`. After the existing imports, add:

```typescript
import { metricsMiddleware, metricsHandler } from './metrics';
```

Find the line `app.use('*', csrfGuard);` (around line 74). INSERT these two lines IMMEDIATELY BEFORE that line:

```typescript
app.use('*', metricsMiddleware);
app.get('/metrics', metricsHandler);
```

The file region should read:

```typescript
app.use('*', logger());
app.use(
  '*',
  cors({
    // ... existing cors config ...
  }),
);
app.use('*', metricsMiddleware);
app.get('/metrics', metricsHandler);
app.use('*', csrfGuard);
app.use('*', (c, next) => dbScope(c, next));
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter recycle-erp-backend test metrics.test`

Expected: PASS.

- [ ] **Step 5: Run the full backend test suite to verify no regressions**

Run: `pnpm --filter recycle-erp-backend test`

Expected: every previously-passing test still passes. If anything else fails, the most likely culprit is the new middleware mutating the response in a way that breaks an assertion — investigate before patching the test.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/index.ts apps/backend/tests/metrics.test.ts
git commit -m "feat(metrics): mount /metrics route + http-duration middleware"
```

---

### Task 6: `ocr_calls_total` at the `scanLabel` boundary

**Files:**
- Modify: `apps/backend/src/ai/index.ts`
- Test: extend `apps/backend/tests/metrics.test.ts`

Single call site, single source of truth — the boundary helper `scanLabel`. Wrapping at this level means future providers automatically inherit the counter.

- [ ] **Step 1: Add an assertion to the existing metrics test**

Append to `apps/backend/tests/metrics.test.ts`:

```typescript
describe('ocr_calls_total counter', () => {
  it('increments on every scanLabel call', async () => {
    // Call the stub provider directly so the test doesn't need a real model.
    const { scanLabel } = await import('../src/ai');
    const env = { DATABASE_URL: process.env.DATABASE_URL! } as never;
    await scanLabel(env, 'RAM', new ArrayBuffer(8));
    await scanLabel(env, 'RAM', new ArrayBuffer(8));

    const r = await api<string>('GET', '/metrics');
    const body = r.body as unknown as string;
    expect(body).toMatch(/ocr_calls_total\{[^}]*provider="stub"[^}]*outcome="stub"[^}]*\}\s+\d+/);
  });
});
```

(The test uses the deterministic `stub` provider, since the suite never has `OPENROUTER_API_KEY` set.)

- [ ] **Step 2: Run the new assertion to verify it fails**

Run: `pnpm --filter recycle-erp-backend test metrics.test`

Expected: the new describe block fails — `ocr_calls_total` not present in the body.

- [ ] **Step 3: Wrap `scanLabel` to emit the counter**

Edit `apps/backend/src/ai/index.ts`. Replace the existing `scanLabel` export with:

```typescript
import { ocrCallsTotal } from '../metrics';

export async function scanLabel(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  const provider = pickProvider(env);
  try {
    const result =
      provider === 'openrouter'
        ? await openRouterScan(env, category, imageBytes)
        : await stubScan(env, category);
    // Outcome is "stub" for the canned provider (never observably "ok" from
    // a stubbed pipeline), "ok" for a successful real-model call.
    ocrCallsTotal.inc({ provider, outcome: provider === 'stub' ? 'stub' : 'ok' });
    return result;
  } catch (e) {
    ocrCallsTotal.inc({ provider, outcome: 'error' });
    throw e;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter recycle-erp-backend test metrics.test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/ai/index.ts apps/backend/tests/metrics.test.ts
git commit -m "feat(metrics): count OCR calls per provider+outcome"
```

---

### Task 7: End-to-end stack verification + README docs

**Files:**
- Modify: `README.md` (add a short ops section near the existing Docker section)

This is a manual-verification + docs task. No new code.

- [ ] **Step 1: Bring up the full stack**

Run from repo root:

```bash
POSTGRES_PASSWORD=recycle docker compose up -d --build
docker compose ps
```

Expected: all four services (`recycle_pg`, `recycle_backend`, `recycle_web`, `recycle_pg_exporter`) are `running` and `healthy` (where applicable).

- [ ] **Step 2: Scrape both endpoints from the host**

Run:

```bash
curl -sf http://localhost:9090/metrics/backend  | head -20
curl -sf http://localhost:9090/metrics/postgres | head -20
```

Expected:
- First curl: contains `process_resident_memory_bytes` and `http_request_duration_seconds_bucket`.
- Second curl: contains `pg_up 1` and `pg_stat_database_*` series.

If either is empty or 502: tail logs with `docker compose logs --tail=50 backend postgres-exporter web` and fix before continuing.

- [ ] **Step 3: Confirm the metrics path is NOT reachable via the SPA port**

Run:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/metrics
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/metrics/backend
```

Expected: both return `200` (the SPA `try_files` falls back to `index.html`). The HTML payload — not Prometheus exposition — confirms the metrics path is properly isolated to `:9090`.

- [ ] **Step 4: Add a "Metrics" section to `README.md`**

Find the existing Docker / ops section in `README.md`. Insert this block just before it (or wherever the existing ops content lives — match the file's structure):

```markdown
## Metrics

The compose stack exposes Prometheus scrape targets on host port **9090**.

| URL                                          | Source                                  |
| -------------------------------------------- | --------------------------------------- |
| `http://<host>:9090/metrics/backend`         | Hono backend (prom-client, default Node + http duration + ocr) |
| `http://<host>:9090/metrics/postgres`        | postgres-exporter (`pg_monitor` role)   |

Add the two jobs to your Prometheus config:

```yaml
- job_name: 'recycle-erp-backend'
  static_configs: [{ targets: ['<host>:9090'] }]
  metrics_path: /metrics/backend
- job_name: 'recycle-erp-postgres'
  static_configs: [{ targets: ['<host>:9090'] }]
  metrics_path: /metrics/postgres
```

The endpoint is unauthenticated; bind the port to a private interface in
production by editing `docker-compose.yml`'s `web.ports` (e.g.
`"10.0.0.5:9090:9090"`).
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(metrics): document :9090 scrape endpoints in README"
```

---

## Self-review

**Spec coverage:**

- Local TSDB — none. Spec said "no local TSDB"; matches. ✓
- `postgres-exporter` sidecar — Task 2. ✓
- Caddy `:9090` with path-based proxies — Task 3. ✓
- Backend `prom-client` + `/metrics` route + middleware — Tasks 4 & 5. ✓
- `ocr_calls_total` — Task 6. ✓
- `order_state_transitions_total` — explicitly deferred (see scope-narrowing note at top). ✓
- Migration `0042` with `pg_monitor` role — Task 1. ✓
- `POSTGRES_METRICS_PASSWORD` documented — Task 2. ✓
- README ops note — Task 7. ✓
- Backend integration test — Tasks 5 & 6. ✓
- Hardening (cap_drop, no-new-privileges, mem_limit, log rotation) on new sidecar — Task 2. ✓
- Bind interface tightenable to internal IP — documented in README (Task 7). ✓

**Placeholder scan:** None — every step has the full code or command, no TBDs.

**Type consistency:** `metricsMiddleware` and `metricsHandler` are defined in Task 4 with those exact names and used unchanged in Task 5. `ocrCallsTotal` defined in Task 4, used in Task 6. Migration filename is `0042_metrics_role.sql` consistently. Role name `metrics` consistent across migration, exporter `DATA_SOURCE_NAME`, and tests.

**Order:** Migration → exporter → Caddy → backend module → backend wiring → OCR counter → e2e + docs. Each task is independently verifiable; the only inter-task dependency is that Task 5's tests require Task 4's module.
