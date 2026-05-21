# Recycle Servers ERP

Inventory ERP for a server-parts recycler. Field purchasers scan part labels
with their phone, the AI fills the spec sheet, and the order flows through
warehouse intake → inventory → sell orders → vendor bidding. One backend
serves three React shells out of the same SPA bundle.

## Repository layout

```
apps/
  backend/         Node + Hono + Postgres API.  Mounted under /api/*.
  frontend/        Vite + React SPA.  Mobile / Desktop / Vendor shells.
packages/
  shared/          Types and helpers shared across the workspace.
infra/
  terraform/       Cloudflare R2 bucket + custom domain + token.
docs/
  superpowers/     Per-feature design specs and implementation plans.
docker-compose.yml Production-shaped stack (postgres + backend + Caddy/SPA).
docker-compose.override.yml  Local dev only — re-publishes Postgres on 127.0.0.1.
```

## The three shells

Mounted from one bundle in `apps/frontend/src/App.tsx` (lazy-imported per
shell, so each ships its own chunk):

- **Mobile (`window.innerWidth < 720`)** — Field-purchaser phone app. Login,
  Role picker, Dashboard, Capture (camera + AI), Orders, Market, Profile,
  Language sheet.
- **Desktop (≥ 720)** — Manager UI with sidebar: Dashboard, Purchase Orders,
  Inventory (grouped-by-part-number with per-PO drilldown, or flat),
  Inventory Transfers, Market, Sell Orders, Vendor Bids, Settings
  (Members / Customers / Categories / Warehouses / General).
- **Vendor portal (`/v/<token>`)** — Public, token-scoped pages: browse the
  catalog the manager has published, place bids, view your offers. No
  account, no cookie auth — token in the URL.

## Stack

- **Backend** — Node 22, Hono, postgres.js, `@aws-sdk/client-s3` for R2,
  bcryptjs, `@tsndr/cloudflare-worker-jwt` for JWT.
- **Frontend** — Vite 6, React 18, TypeScript 5, no UI framework.
- **DB** — Postgres 16. 41 SQL migrations under `apps/backend/migrations/`,
  applied automatically by the backend on startup.
- **Storage** — Cloudflare R2 via S3 API.  Label scans + sell-order
  attachments live under `recycle-erp-attachments`, public-served at
  `https://static.recycleservers.com/recycle-erp-attachments/`.
- **OCR** — OpenRouter (Gemma 3 27B by default).  Falls back to a
  deterministic stub when `OPENROUTER_API_KEY` is unset so dev and CI run
  offline.
- **Edge** — Caddy serves the built SPA and reverse-proxies `/api/*` to the
  backend over the compose network.

## Architecture

```
┌─────────────────┐  HTTPS  ┌──────────────────────┐
│  React SPA      │ ──────▶ │  Caddy (web)         │
│  (Caddy-served) │         │   / → static SPA     │
└─────────────────┘         │   /api → backend     │
                            └──────────┬───────────┘
                                       │  internal compose net
                            ┌──────────▼───────────┐
                            │  backend (Node/Hono) │
                            │  Postgres · R2 (S3)  │
                            │  OpenRouter OCR      │
                            └──────────────────────┘
```

## Quick start

The fastest path is the full Docker stack — zero host setup, one command:

```bash
docker compose up -d --build
```

That's it. Open <http://localhost:8080>.  Sign in with
`marcus@recycleservers.io` and any password (dev image ships with
`ENABLE_DEMO_ACCOUNTS=true`).  Mobile-emulate narrower than 720px to land
in the phone shell.

Postgres data lives in `./data/postgres/` (bind-mounted, gitignored,
owned by the in-container postgres user — read with `sudo`).  Wipe with
`docker compose down && sudo rm -rf data/postgres` for a fresh DB.

### Host-side dev loop (faster reload)

If you want vitest + Vite HMR against a local Postgres:

```bash
pnpm install                                                  # pnpm@11.0.9
POSTGRES_PASSWORD=recycle docker compose up -d postgres       # DB only
pnpm db:migrate && pnpm db:seed                               # one-time
pnpm dev                                                       # backend :8787 + SPA :5173
```

Open <http://localhost:5173>.  The `docker-compose.override.yml` re-publishes
Postgres on `127.0.0.1:5432` for the host vitest suite — it is gitignored and
must not ship to prod.

## Auth model

- **No bearer tokens, no `localStorage`.**  Login sets an `at` (access) and
  `rt` (refresh) cookie — both `httpOnly`, `Secure` in prod, `SameSite=Lax`.
- The access cookie is a 15-minute JWT.  The refresh cookie is a rotating
  family — refresh swaps it for a new one and revokes the previous; reuse of
  a revoked token revokes the whole family.
- CSRF: every state-changing request must carry `X-Requested-By: recycle-erp`
  (see `apps/backend/src/csrf.ts`).  Safe methods, `/api/health`, and the
  unauthenticated `/api/public/*` vendor endpoints are exempt.

## Environment

A single `.env` at the repo root drives everything — Compose interpolation,
the backend container's `env_file`, and host-side `pnpm dev` (resolved off the
repo root via `apps/backend/scripts/load-env.mjs`, regardless of CWD). Copy
`.env.example` and fill in. See that file for the full annotated list; the
core keys:

```
POSTGRES_PASSWORD=recycle
DATABASE_URL=postgres://recycle:recycle@localhost:5432/recycle_erp        # localhost for host pnpm dev; compose overrides to postgres:5432
JWT_SECRET=dev-secret-change-me
ADMIN_EMAIL=admin@recycle.local
ADMIN_PASSWORD=admin
OPENROUTER_API_KEY=                                                       # OCR; stub used when absent
R2_S3_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=recycle-erp-attachments
R2_ATTACHMENTS_PUBLIC_URL=https://static.recycleservers.com
# CORS_ALLOWED_ORIGINS=https://erp.recycleservers.com                     # required when NODE_ENV=production
# ENABLE_DEMO_ACCOUNTS=true                                               # dev only — exposes /api/auth/demo-accounts
```

`CLOUDFLARE_API_TOKEN` is deliberately NOT in this file — it belongs in the
shell when running `terraform apply` (see `infra/terraform/`). The backend
talks to R2 over the S3 API using `R2_ACCESS_KEY_ID/SECRET_ACCESS_KEY`.

Frontend dev proxy target is `VITE_API_BASE` (defaults to
`http://localhost:8787`). No `VITE_` vars are baked into prod — Caddy
proxies relative `/api/*`.

## Tests

```bash
pnpm typecheck                 # all workspaces
pnpm --filter recycle-erp-backend  test
pnpm --filter recycle-erp-frontend test
```

Backend tests are integration tests against a real Postgres (~60 files,
~300 tests).  `vitest.config.ts` runs them serially with `pool: 'forks'`
+ `fileParallelism: false`; the shared DB is reset per-file via an
advisory lock to stop catalog-DDL races.

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

## Production deploy

Single-host Docker Compose:

1. Create repo-root `.env` (copy `.env.example`) with `NODE_ENV=production`,
   a real `JWT_SECRET`, `CORS_ALLOWED_ORIGINS`, `POSTGRES_PASSWORD`, the R2
   credentials, and `OPENROUTER_API_KEY`. Those values override the dev
   defaults baked into the backend image (`NODE_ENV=development`, throwaway
   JWT, demo accounts on, `admin/admin` initial user).
2. `docker compose up -d --build` — the backend runs migrations on startup
   and a healthcheck pings `/api/health`.
3. App is at `http://<host>:8080`.  Front it with your TLS-terminating
   reverse proxy.
4. **Do not** ship `docker-compose.override.yml` — it re-publishes Postgres
   on the host loopback for the dev test harness.

Postgres cluster files live in `./data/postgres/` (bind-mount).  Back them
up with `apps/backend/scripts/backup.sh` or snapshot the directory while pg
is stopped.

Daily backups: `bash apps/backend/scripts/backup.sh --out /var/backups/`
(pg_dump custom format, gzipped, retains last 14).

The compose stack is hardened: `cap_drop: ALL` everywhere with the minimum
caps re-added (Postgres needs CHOWN/DAC_OVERRIDE/FOWNER/FSETID/SETGID/SETUID
for its entrypoint user-switch; Caddy needs NET_BIND_SERVICE to bind :80
non-root), `no-new-privileges`, memory limits, JSON log rotation.

## Infrastructure (Terraform)

`infra/terraform/` manages the Cloudflare side: the R2 attachments bucket,
its custom domain (`static.recycleservers.com`), and an API token scoped to
the bucket.  State lives in a separate R2 bucket
(`recycle-erp-tfstate`).  The bucket has `prevent_destroy` set — destroying
it requires editing the lifecycle block first.

See `infra/terraform/environments/prod/` for the prod composition.

## Documentation

Per-feature design and implementation docs live under
`docs/superpowers/`.  Specs (`specs/YYYY-MM-DD-*-design.md`) capture intent
at design time; plans (`plans/YYYY-MM-DD-*.md`) track the build.  Finished
plans graduate to `plans/finished/`.

See also `CLAUDE.md` for conventions and quirks future contributors (human
or AI) should know before changing things.
