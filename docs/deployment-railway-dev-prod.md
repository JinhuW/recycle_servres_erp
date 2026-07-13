# Railway dev + prod environments with prod→dev DB sync

> **Status (2026-06-19): COMPLETE.**
> - ✅ Git branches `prod` + `dev` pushed.
> - ✅ Railway `production` env (backend `backend-production-7b10`, own Postgres,
>   tracks `prod` branch) and forked `dev` env (backend `backend-dev-f94e`, own
>   Postgres, tracks `dev` branch).
> - ✅ **Prod→dev sync verified** — `pg_dump --clean prod | psql dev` run via a
>   `postgres:18-alpine` container; dev mirrored prod (row counts matched).
> - ✅ **Native Railway cron service `db-sync`** in the `dev` env: builds the
>   `deploy/railway-sync/Dockerfile` (pinned via `railway.toml`), `cronSchedule
>   = "0 4 * * *"` UTC, `restartPolicyType = NEVER`. Variables `PROD_DATABASE_URL`
>   (prod `DATABASE_PUBLIC_URL`) + `DEV_DATABASE_URL` (`${{Postgres.DATABASE_URL}}`).
>   Build SUCCESS; first scheduled run 04:00 UTC.
> - ✅ **Two frontend Workers** (`deploy/cloudflare`, wrangler envs): `recycle-erp-prod`
>   at **`inventory-prod.recycleservers.com`** → prod backend, and `recycle-erp-dev`
>   at **`inventory-dev.recycleservers.com`** → dev backend. Each backend's
>   `CORS_ALLOWED_ORIGINS` (and OAuth issuer) set to its own custom domain;
>   verified each domain proxies to the correct backend.

## Origin lockdown (Worker ↔ Railway shared secret)

The Railway backend has a public URL, so without a gate anyone could bypass the
Worker and hit it directly (including the unauthenticated `/metrics`). A shared
secret closes that:

- The Worker injects `X-Proxy-Secret: <PROXY_SECRET>` on every proxied request
  (`deploy/cloudflare/worker.js`).
- The backend refuses any request lacking it with **403** (`apps/backend/src/index.ts`),
  **except `/api/health`** (Railway's healthcheck probes the container directly,
  bypassing the Worker). When `PROXY_SECRET` is unset the gate is **off**, so the
  Docker stack / local dev are unaffected.
- `PROXY_SECRET` is a Cloudflare **Worker secret** (`wrangler secret put
  PROXY_SECRET --env prod|dev`) and a Railway backend env var — never in the repo.
  **Independent value per environment** (prod Worker ↔ prod backend, dev ↔ dev).

Verified: direct Railway `/.well-known` + `/metrics` → 403; direct `/api/health`
→ 200; everything via the Worker custom domains → 200.

> **Ordering when rotating the secret:** set it on the Worker (and deploy) first,
> then on the backend — otherwise the Worker's own requests get 403 in the gap.

## Frontend (Cloudflare)

Two Workers from one `wrangler.toml`, deployed per environment. Each serves the
SPA and reverse-proxies `/api`,`/oauth`,`/.well-known` to its **own** backend, so
each domain is same-origin end-to-end.

| Worker | Custom domain | BACKEND_URL |
|--------|---------------|-------------|
| `recycle-erp-prod` | `inventory-prod.recycleservers.com` | prod backend (`backend-production-7b10`) |
| `recycle-erp-dev`  | `inventory-dev.recycleservers.com`  | dev backend (`backend-dev-f94e`) |

```bash
# Deploy (custom domains auto-provisioned on the recycleservers.com zone).
# The script builds the frontend, runs wrangler, then smoke-checks every
# public hostname through Cloudflare — a 523 here means the custom domain
# binding broke even though Railway is green.
deploy/cloudflare/deploy.sh prod
deploy/cloudflare/deploy.sh dev
```

Prod deploys also run automatically on pushes to the `prod` branch
(`.github/workflows/deploy-frontend.yml`, needs the `CLOUDFLARE_API_TOKEN`
repo secret). Never attach a hostname to a Worker via the Cloudflare
dashboard — declare it in `wrangler.toml` routes instead, or the next deploy
deletes its DNS record + cert (2026-07-12 outage).

Attaching a custom domain disables that Worker's `*.workers.dev` URL (Cloudflare
default); add `workers_dev = true` per env to keep it. Each backend's
`CORS_ALLOWED_ORIGINS` must match its frontend's custom domain.

## Topology

Two git branches, two Railway environments in the `recycle-erp-experiment`
project, each its own backend + Postgres. Prod data flows one-way into dev so
dev runs against realistic data.

```
GitHub branch  prod ───► Railway env "production"  ── backend ── Postgres (prod)
                                                                     │
                                                          nightly    │  pg_dump --clean
                                                          prod→dev    ▼
GitHub branch  dev  ───► Railway env "dev"  ── backend ── Postgres (dev)  ◄── overwritten
                                                  ▲
                                             sync service (cron)
```

- **prod env** tracks the `prod` branch; **dev env** tracks the `dev` branch.
  Each backend auto-deploys when its branch changes (watch patterns scope
  rebuilds to `apps/backend/**` + `packages/shared/**`).
- **Sync is one-directional, prod → dev.** Dev's database is clobbered to mirror
  prod. The job NEVER writes to prod (`deploy/railway-sync/sync.sh` refuses if
  source == target).

## Files in this repo

| Path | Purpose |
|------|---------|
| `deploy/railway-sync/Dockerfile` | `postgres:18-alpine` sync image |
| `deploy/railway-sync/sync.sh` | `pg_dump --clean prod \| psql dev`, one-way, guarded |

## Provisioning steps (need Railway API access)

### 1. Point production at the `prod` branch

`connect_service_source` on the production backend → repo `JinhuW/recycle_servres_erp`, branch `prod`.

### 2. Fork the dev environment

`create_environment` name `dev`, `source_environment_id` = production env. This
copies the backend + Postgres services into a fresh `dev` environment (new,
empty Postgres volume — it gets filled by the sync).

Then in the **dev** env: `connect_service_source` the dev backend → branch `dev`,
and fix dev-specific vars (`CORS_ALLOWED_ORIGINS` → the dev frontend origin).

### 3. Expose prod Postgres for cross-environment reads

Cross-environment private DNS isn't available, so the dev sync service reaches
prod over a public TCP proxy: `create_tcp_proxy` on the prod Postgres
(application_port 5432). Build `PROD_DATABASE_URL` from the proxy host/port +
the prod DB credentials.

### 4. Create the sync cron service (in the dev env)

- Source: the `dev` branch; build root `deploy/railway-sync`, Dockerfile `Dockerfile`.
- Cron schedule: e.g. `0 4 * * *` (after the 03:00 backup).
- Restart policy: `NEVER`.
- Variables:
  - `PROD_DATABASE_URL` = prod Postgres via the TCP proxy (step 3)
  - `DEV_DATABASE_URL` = reference `${{Postgres.DATABASE_URL}}` (dev env's Postgres)

### 5. Verify

Temporarily clear the cron, deploy once so it runs immediately, read logs for
`[sync] done`, and confirm dev shows prod's row counts. Then restore the schedule.

## Safety notes

- The sync OVERWRITES dev every run — never store dev-only data you can't lose.
- One-directional by construction; the script aborts if `PROD_DATABASE_URL ==
  DEV_DATABASE_URL`.
- Consider a prod **read-only** role for `PROD_DATABASE_URL` so the sync can only
  read prod, not modify it.
- The prod→dev copy includes all prod data — treat the dev DB and its access
  with the same sensitivity as prod.
