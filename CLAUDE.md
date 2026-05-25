# Recycle Servers ERP — Conventions

Read [README.md](./README.md) first for the what.  This file is the how:
the conventions, quirks, and tripwires that aren't obvious from the code.

## Workspace

- **pnpm only** — `packageManager` is pinned to `pnpm@11.0.9` and the lockfile
  is `pnpm-lock.yaml`.  Don't introduce `package-lock.json` or `yarn.lock`.
- Workspaces are declared in `pnpm-workspace.yaml`: `apps/*` and `packages/*`.
- Common entry points from the repo root:
  - `pnpm dev` — runs backend (`:8787`) and frontend (`:5173`) in parallel.
  - `pnpm typecheck` / `pnpm build` — recursive across the workspace.
  - `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` — proxy to backend
    scripts.
  - `pnpm --filter recycle-erp-backend test` (vitest, integration) and
    `pnpm --filter recycle-erp-frontend test`.
- The `@recycle-erp/shared` package is imported as a workspace dep (`main:
  "./src/index.ts"`) — there's no build step.  Don't add one.

## Frontend

- One bundle, three shells.  `apps/frontend/src/App.tsx` decides which to
  render: vendor token in `/v/<token>` → `VendorApp`; else viewport width
  `< 720` → `MobileApp`; else `DesktopApp`.  Each is lazy-imported so each
  shell ships its own chunk.  When adding a feature, identify which shell(s)
  it lives in and keep its components scoped to that subtree
  (`pages/desktop/`, `pages/` for mobile, `VendorApp.tsx` for the portal).
- Use `apps/frontend/src/lib/api.ts` for every backend call.  It sets
  `credentials: 'include'`, attaches the `X-Requested-By: recycle-erp` CSRF
  header on mutating requests, and single-flights refresh.  Do **not** call
  `fetch('/api/…')` directly — you'll skip CSRF and refresh logic.
- Translatable strings go through `useT()` from `lib/i18n.tsx`.  Don't ship
  raw English in JSX.
- User preferences (theme, list-view modes, etc.) flow through
  `lib/preferences.tsx`.  Add new keys there, not in component-local state.

## Backend

- Hono on `@hono/node-server` (Node 22).  Entry: `apps/backend/src/server.ts`
  → `index.ts` mounts all routes under `/api/*`.
- **One shared Postgres pool**, lazily created (`apps/backend/src/db.ts`).
  Do not new-up `postgres()` clients inline; call `getDb(env)`.  The historical
  per-request pool design caused connection exhaustion under load — don't
  bring it back.
- **Transactions use `sql.begin(async (tx) => …)`** (postgres.js).  Multi-table
  writes that have to be atomic (notably anywhere `notify` is involved — see
  `lib/notify.ts`) must run inside `sql.begin` and pass `tx` down, not a
  fresh `sql`.
- **Status guards.**  Purchase orders, sell orders, transfer orders, and
  vendor bids each have explicit allowed-transition tables in their route
  files.  When adding a new state-changing endpoint, extend the existing
  guard — don't write a parallel one.
- **Order ID counters** are per-type sequences in `id_counters` (see
  `migrations/0029`).  Use `lib/id-seq.ts`; never compute an ID by counting
  rows.
- **Upload validation** — `routes/attachments.ts` enforces both
  `maxBytes` and `allowedMime` from `lib/settings.ts → getUploadLimits()`.
  The allowed set is intersected with `SAFE_UPLOAD_MIME` so a misconfigured
  DB setting can't widen the surface.  Keep it that way.
- **Migrations** are plain SQL under `apps/backend/migrations/`, numbered
  `NNNN_…sql`.  The backend runs them on startup via `scripts/migrate.mjs`,
  recorded in `_migration_ledger`.  Always add the next number; never edit
  a migration that's been deployed.

## Auth & CSRF

- httpOnly `at` (15-min JWT) + `rt` (rotating refresh family) cookies.  No
  `localStorage`, no bearer tokens.  See [auth_cookie_model.md][1] in memory.
- Every mutating request must carry `X-Requested-By: recycle-erp` (the
  `csrfGuard` middleware drops it otherwise with 403).  Exempt: safe methods,
  `/api/health`, and `/api/public/*` (the unauthenticated vendor endpoints
  — they use URL tokens, not cookies, so CSRF doesn't apply).
- Refresh-token reuse revokes the whole family.  Don't relax that.

## Database & migrations

- Postgres 16.  41 migrations as of writing — the highest-numbered file in
  `apps/backend/migrations/` is the head.
- FKs use `ON DELETE` rules added in `0041_fk_on_delete.sql`.  When adding
  a new child table, declare the rule explicitly; don't rely on default
  `NO ACTION`.
- FK indexes are managed in `0035_fk_indexes.sql` and `0040_perf_indexes.sql`.
  When you add a FK, add the matching index in the same migration.

## Tests

- Backend tests are **integration tests against a real Postgres**
  (`vitest.config.ts` runs `pool: 'forks'` + `fileParallelism: false`).  They
  need `127.0.0.1:5432` reachable — `docker-compose.override.yml` does that
  for local dev.  Production compose doesn't ship the override.
- `resetDb()` in `tests/helpers/db.ts` is **advisory-locked** to serialize
  catalog DDL across the suite + the external `seed.mjs` process.  If you
  see a flood of unrelated test failures, suspect the harness (lock
  contention, stale connections) before logic regressions.  Don't disable
  the lock.
- Frontend tests are sparse (~6 files).  Add coverage when you add a
  non-trivial pure helper; UI behavior is mostly validated by visiting it.
- **To run a single backend test file**, `cd apps/backend && npx vitest run
  tests/foo.test.ts` — `pnpm --filter recycle-erp-backend test -- tests/foo.test.ts`
  silently drops the path and runs the full ~400-test suite (which then
  trips the known shared-DB flakiness in `test_harness_resetdb`).

## Storage & OCR

- Label scans and sell-order attachments are uploaded to **Cloudflare R2**
  via the S3 SDK (`apps/backend/src/r2.ts`).  Public URL pattern:
  `R2_ATTACHMENTS_PUBLIC_URL/<key>`.  The base **must** include the
  `/<bucket>` segment when the R2 custom domain serves at `/<bucket>/<key>`
  (as `static.recycleservers.com` does).
- **Don't reintroduce Cloudflare Images** — it's paywalled (error 5453); we
  migrated everything to R2 attachments.  See [cloudflare_images_unpaid_stubbed][2].
- **OCR provider selection** lives in `apps/backend/src/ai/`.  OpenRouter
  (Gemma 3 27B) when `OPENROUTER_API_KEY` is present; otherwise a
  deterministic stub.  **The fallback is silent** — a prod deploy missing
  the key looks healthy and quietly stubs.  Verify the secret is set when
  cutting a release.

## Docker & ops

- `docker-compose.yml` is the prod-shaped stack.  Every service has
  `cap_drop: ALL` + `no-new-privileges` + memory caps + JSON log rotation.
  When you add a service, copy that block.
- The Postgres container is **not host-published** in prod — `backend`
  reaches it as `postgres:5432` over the compose net.  The override file
  re-publishes it on `127.0.0.1:5432` for the host vitest suite only.  Never
  bind it to `0.0.0.0`.
- Postgres needs `CHOWN, DAC_OVERRIDE, FOWNER, FSETID, SETGID, SETUID`
  re-added (its entrypoint runs as root then drops to `postgres`).  Caddy
  needs `NET_BIND_SERVICE` (binds :80 non-root via file caps).  Don't widen
  these.
- Single `.env` at the repo root drives the whole stack — Compose
  interpolation, the backend container's `env_file:`, and host-side
  `pnpm dev` (via `apps/backend/scripts/load-env.mjs`, which resolves the
  path off its own location so CWD/workspace filter don't matter).
  `POSTGRES_PASSWORD` defaults to `recycle` if unset; override in prod.
  See [docker_compose_ops][3].
- `CORS_ALLOWED_ORIGINS` is required in production — the backend throws on
  startup if `NODE_ENV=production` and it's unset.
- **Unhandled-500 sink.** `app.onError` writes a JSONL record to
  `ERROR_LOG_DIR/errors.jsonl` (compose mounts `./data/errors:/var/log/recycle-erp`).
  Rotates at 10 MB, keeps last 10.  Pre-create the host dir with
  `mkdir -p data/errors && sudo chown 1000:1000 data/errors` — without it
  the backend (UID 1000) can't write and the sink silently degrades to
  stdout-only.  See `apps/backend/src/lib/error-log.ts`.

## Infrastructure (Terraform)

- `infra/terraform/` owns Cloudflare side: R2 attachments bucket, custom
  domain, scoped API token.  State lives in the `recycle-erp-tfstate` R2
  bucket.  See [terraform_cloud_infra][4].
- The attachments bucket carries `prevent_destroy = true`.  If you need to
  destroy it, edit the lifecycle block in the same change — don't pass
  `-target` flags to work around it.

## Fixed business rules

- **Commission payment types are exactly two**: Company pay and Self pay.
  Don't expose UI to add, remove, or rename them.  Backend enums and seed
  data assume the closed set.  See [commission_payment_types][5].

## Style

- Prefer editing existing files over adding new ones.  Match the
  surrounding style.
- Comments: only the `Why`, not the `What`.  Don't reference issue numbers,
  current task, or the PR — those rot.  See existing route files for the
  tone: terse, contextual, only present where a future reader would be
  surprised.
- Don't add fallbacks, error handlers, or feature flags for scenarios that
  can't happen.  Validate at boundaries; trust internal code.

## Pointers

- Per-feature design docs: `docs/superpowers/specs/`.
- Implementation plans (in-flight and finished): `docs/superpowers/plans/`.
- Auto-memory referenced above lives under
  `~/.claude/projects/-srv-data-recycle-erp/memory/`.

[1]: docs/superpowers/specs/2026-05-18-frontend-auth-overhaul-design.md
[2]: docs/superpowers/specs/2026-05-12-ai-scan-image-preview-design.md
[3]: docs/superpowers/specs/2026-05-16-docker-migration-design.md
[4]: docs/superpowers/specs/2026-05-17-cloudflare-terraform-module-design.md
[5]: docs/superpowers/specs/2026-05-17-per-order-commission-rate-design.md
