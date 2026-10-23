# ERP backend — `apps/backend/`

The root [AGENTS.md](../../AGENTS.md) has the repo map, workflow and the
ERP↔tracker contracts; this file is the backend's conventions.  Bare paths
such as `lib/log.ts` or `routes/orders/` are under `apps/backend/src/`;
anything else is relative to the repo root.

`routes/tracker.ts`, `routes/coordinator.ts` and `vncBridge.ts` are the ERP
half of the tracker contracts — change them together with the tracker side
(root AGENTS.md → *Contracts*).

## Backend

- Hono on `@hono/node-server` (Node 24).  Entry: `apps/backend/src/server.ts`
  → `index.ts` mounts all routes under `/api/*`.
- **All logging goes through `lib/log.ts`** — `log.info/warn/error/debug(msg,
  detail)`, never `console.*`.  Every line is one JSON object stamped with the
  release `version` and `commit`, so a log excerpt identifies its build without
  cross-referencing the deploy history.  `detail` may be an `Error` (unwrapped
  to `error`/`stack`) or any object (merged as fields); `log.child({…})` pins
  fields like `module` or `requestId` onto a scope.  `LOG_LEVEL` (default
  `info`) filters.  `releaseVersion()`/`releaseCommit()` from the same module
  are the single source of build provenance — `/api/health` uses them too.
- **`requestId` and `userId` are ambient, not passed.**  The outermost
  middleware in `index.ts` opens an `AsyncLocalStorage` context
  (`runWithLogContext`), so *every* line emitted during a request carries the
  id — including from `r2.ts`, `image-shrink.ts` and the MCP tools, which never
  see a Hono `Context`, and including a `.catch()` that settles after the
  response (the context follows a promise reaction from where it was
  *registered*).  `addLogContext({ userId })` fills in what auth learns later
  (`auth.ts`, `oauth/guard.ts`).  Precedence is ambient < `log.child` < the
  call's own fields.  Keep the store to scalars — a detached promise holds it
  alive, so a `Context` or request body parked there pins the request's memory.
- **Keep `log.ts` free of intra-repo imports** (`node:` builtins only):
  `scripts/migrate.mjs` and `scripts/init-admin.mjs` are plain-`node` `.mjs`
  that import it directly and lean on Node 24's TypeScript type-stripping,
  which cannot resolve the extensionless specifiers the rest of `src/` uses —
  breaking it fails *container boot*.  `tests/log-import-purity.test.ts`
  enforces this.  (`scripts/seed.mjs` stays on `console` — it is a dev/test CLI
  and never runs in a deployed container.)
- **Don't log attacker-controlled parse failures** — cursor decode
  (`lib/pagination.ts`), JWT verify (`auth.ts`), the `c.req.json().catch()`
  body parses.  They are a free log-flood and, through the error sink, a
  disk-fill; the 4xx is the record.  Same for OCR model output
  (`ai/prompts.ts`): it is a transcription of a customer receipt.
- **One shared Postgres pool**, lazily created (`apps/backend/src/db.ts`).
  Do not new-up `postgres()` clients inline; call `getDb(env)`.  The historical
  per-request pool design caused connection exhaustion under load — don't
  bring it back.
- **Fan out per-request reads with `allLimited` (`lib/concurrency.ts`), at
  most 4 at a time.**  The prod pool is `max: 10` and postgres.js pipelines
  past it onto busy connections, so an unbounded `Promise.all` on a hot page
  queues other requests behind it.  Never use it inside `sql.begin` — a
  transaction is one connection.
- **Transactions use `sql.begin(async (tx) => …)`** (postgres.js).  Multi-table
  writes that have to be atomic (notably anywhere `notify` is involved — see
  `lib/notify.ts`) must run inside `sql.begin` and pass `tx` down, not a
  fresh `sql`.
- **PO routes live in `routes/orders/`, one module per concern** (v1.197.4):
  `list`, `detail`, `create`, `patch`, `lifecycle` (revert-ack, delete,
  archive, lot-price reset, advance, hand-off), `evidence` (status meta,
  photos), `checks` (Review mode) and `spreadsheet`, each a Hono sub-app
  mounted by `index.ts`.  Helpers two modules share go in `shared.ts`.  A
  write refused inside its transaction throws `OrderRefusal` (`refusal.ts`)
  with a typed `kind` and payload, and the handler's catch returns
  `refusalResponse`.
- **Status guards.**  Purchase orders, sell orders and transfer orders each
  have explicit allowed-transition tables in their route files.  When adding a new state-changing endpoint, extend the existing
  guard — don't write a parallel one.
- **One lock order: orders rows (sorted) before lines** (v1.197.0).  Lock a
  PO with `FOR NO KEY UPDATE` unless the transaction deletes it, because
  `FOR UPDATE` blocks the `FOR KEY SHARE` a line INSERT's FK check takes.  A
  writer that locks lines and later updates `orders` (goods-total sync, sold
  settlement) calls `lockOrdersForLinesTx` (`services/orderLocks.ts`) first.
  Getting this wrong is a 40P01 that surfaces as a 500;
  `tests/stock-lock-order.test.ts` races the known pairs.
- **"How much of this line is free" has one implementation**: `committedQtySql`
  / `committedClaimsByLine` in `lib/sellCommitment.ts`.  Don't hand-roll the
  `SUM(sol.qty)` subquery again; ten drifted copies is what it replaced.
- **Order ID counters** are per-type sequences in `id_counters` (see
  `migrations/0029`).  Use `lib/id-seq.ts`; never compute an ID by counting
  rows.
- **A PO product's `#` is `order_lines.product_no`, stored and never
  renumbered** (v1.234.0).  A `BEFORE INSERT` trigger (0169) gives a row
  that names none the PO's next `#` from `orders.next_product_no`, so app
  inserts leave it out.  The one exception is a partial transfer's clone,
  which names its source's `#`, so `(order_id, product_no)` is not unique.
  Hand-written SQL that moves a row to another PO must give it the target's
  next `#`, never carry the old one.
- **`orders.category` and `orders.total_cost` are derived from the lines**, by
  `services/orderCategory.ts` and `services/orderGoodsTotal.ts`, at the end of
  every transaction that writes lines.  **Clients must not send `totalCost`** —
  the API still accepts it, but a value there is read as a *negotiated lot
  price* and pins the column against the lines from then on.  The mirror /
  negotiated verdict has to be read *before* the line writes
  (`goodsTotalIsMirror`); afterwards a stale mirror and a real override are
  indistinguishable.
- **A supplier's identity is the SQL function `supplier_name_key()`**
  (migration 0151), which `suppliers.match_key` is generated from and which
  the suggestions, package adoption and duplicate lookup all call.  Don't
  compress a name in TypeScript.
- **Bank rows carry `currency`** (0153).  Reconciliation is USD-only
  (`openRowFrag`, `pairEligibleFrag`, autoPair, auto-link, `/link`, `/pair`).
  A new matcher has to filter on it too.
- **Upload validation** — every upload route (status-meta evidence and line
  photos in `routes/orders/`/`sellOrders.ts`, `scan.ts`, `publicForms.ts`) and the
  storage layer (`r2.ts`) enforce both `maxBytes` and `allowedMime` from
  `lib/settings.ts → getUploadLimits()`.
  The allowed set is intersected with `SAFE_UPLOAD_MIME` so a misconfigured
  DB setting can't widen the surface.  Keep it that way.
- **Migrations** are plain SQL under `apps/backend/migrations/`, numbered
  `NNNN_…sql`.  The backend runs them on startup via `scripts/migrate.mjs`,
  recorded in `schema_migrations` with a sha256 `checksum` (an edited,
  already-applied file logs a warning; its edit never runs).  Each file runs
  under `lock_timeout = '10s'` and is retried on 55P03, so a migration queued
  behind the old instance's transactions doesn't stall the app.  Always add the
  next number; never edit a migration that's been deployed.
- The shared pool sets `statement_timeout` and
  `idle_in_transaction_session_timeout` to 60s (`db.ts`).  A job that
  legitimately runs longer must `SET LOCAL statement_timeout` inside its tx.

## Auth & CSRF

- httpOnly `at` (60-min JWT) + `rt` (rotating refresh family) cookies.  No
  `localStorage`, no bearer tokens.  See [the auth design][1].
- The `rt` cookie is scoped to `path=/api/auth`, so no other route can see it.
  A route that needs the caller's session reads the `fid` claim from the
  verified `at` JWT instead (`/api/me/password` does).
- Every mutating request must carry `X-Requested-By: recycle-erp` (the
  `csrfGuard` middleware drops it otherwise with 403).  Exempt: safe methods,
  `/api/health`, and `/api/public/*` (the unauthenticated website intake and
  quote forms and the Shippo webhook — no cookies, so CSRF doesn't apply).
- Refresh-token reuse revokes the whole family.  Don't relax that.
- A password change or reset stamps `users.tokens_valid_after`
  (app-clock second); `authMiddleware` and `bearerGuard` refuse any token whose
  `iat` is older.  The self-change caller keeps its refresh family, so it
  re-authenticates through one ordinary refresh — don't re-issue cookies from
  `/api/me` (`setAuthCookies` would overwrite `rt`, which that path can't see).

## MCP & OAuth (connectors)

- `/api/mcp` is **Bearer-only and CSRF-exempt**, mounted with
  `bearerGuard({ scopes: [] })` — it requires a *valid* token, nothing more.
  Per-tool gating lives in the `TOOLS` registry (`src/mcp/server.ts`; each
  entry pairs a tool's scope with its handler) and filters both
  `tools/list` and `tools/call`.  A connector that seems to be missing tools is
  a scope problem, not a missing-tool one.
- **The public origin in every OAuth document comes from `resolvePublicOrigin`**
  (`src/oauth/metadata.ts`), which needs the Cloudflare Worker to forward
  `X-Public-Host` **and** the hostname to be in `CORS_ALLOWED_ORIGINS`.
  It must be `X-Public-Host`, not `X-Forwarded-Host` — **Railway's edge rewrites
  the standard `X-Forwarded-*` headers to its own hostname**, so a value the
  Worker sets there never reaches the backend.  Add
  a hostname to `wrangler.toml` without adding it to `CORS_ALLOWED_ORIGINS` and
  discovery silently advertises `allow[0]` instead — which breaks the RFC 9728
  `resource` match and every MCP client with it.  Canonical host goes first.
- **DCR is open by default** (`OAUTH_DCR_OPEN !== 'false'`), rate-limited per IP
  and globally.  `registration_endpoint` is advertised only when it's on — an
  endpoint that 403s makes clients fail hard instead of falling back to a
  manual client ID.
- Interactive consent is role-ceilinged (`restrictScopesToRole`): a **manager**
  can grant any scope; every other role keeps only `market:read` — sell-order
  reads included in the drop, not just `:write`.  Re-derived on every refresh
  rotation.  Manager-minted service clients are exempt.
- Loopback redirect URIs match **ignoring the port** (RFC 8252 §7.3) so Claude
  Code's ephemeral port works.  That applies to the `/authorize` allowlist only —
  the token endpoint stays an exact match against the URI recorded on the code.
- `/oauth/authorize` accepts only the `at` cookie and bounces to
  `/login?next=…`.  The SPA **must** honour `next` (`readSafeNext` in
  `lib/route.ts`, consumed in `DesktopApp.tsx`/`MobileApp.tsx`) or the connector
  popup dead-ends on the dashboard.

## Database & migrations

- Postgres 18 on Railway prod and in CI; `docker-compose.yml` stays on 16
  until its data directory gets a dump/restore.  The highest-numbered file
  in `apps/backend/migrations/` is the head.
- FKs use `ON DELETE` rules added in `0041_fk_on_delete.sql`.  When adding
  a new child table, declare the rule explicitly; don't rely on default
  `NO ACTION`.
- FK indexes are managed in `0035_fk_indexes.sql` and `0040_perf_indexes.sql`.
  When you add a FK, add the matching index in the same migration.
- `docs/DATABASE.md` describes every table and column. A migration that adds,
  drops or changes a table updates that table's section, and the *As of* line,
  in the same PR.

## Tests

- Backend tests are **integration tests against a real Postgres** — they
  exercise the real SQL, migrations, FK rules, and status guards (the layer
  most likely to break), so the DB dependency is intentional, not a smell.
  They need `127.0.0.1:5432` reachable — `docker-compose.override.yml` does
  that for local dev.  Production compose doesn't ship the override.
  CI runs them against a `postgres:18` service container (prod's major)
  (`.github/workflows/backend-tests.yml`), which must set `TEST_DATABASE_URL`
  in the job env: `global-setup.ts` otherwise falls back to the repo-root
  `.env`, which doesn't exist on a runner, and throws.
- **Test files run in PARALLEL** (`vitest.config.ts`: `pool: 'forks'`, files
  parallel, `maxWorkers` 8 by default — override with `VITEST_MAX_FORKS`).  Each
  fork owns a **private database**: `global-setup.ts` hands every worker a
  run-scoped base name; `tests/helpers/db.ts` suffixes it with `VITEST_POOL_ID`
  (`<run>_w<id>`).  The suite runs in ~15s, not ~8min.
- `resetDb()` is a **template clone**, not a re-migrate.  Each worker builds a
  migrated+seeded **template** DB once (`<run>_w<id>_tmpl`), then every test
  drops its working DB and re-clones it via `CREATE DATABASE … TEMPLATE`
  (~30ms vs ~850ms for the old drop→migrate→seed).  This is why there's no
  per-test seed subprocess and the suite stays under `max_connections=100`
  even at high parallelism.  Keep test-side pools small (`DB_POOL_MAX`,
  `SEED_POOL_MAX`) — many parallel workers share the connection budget.
  The template is migrated by **spawning `scripts/migrate.mjs`** (the boot
  runner, so a migration that can't run in a transaction fails here first),
  built as `<…>_tmpl_building` and renamed only once migrate and seed both
  succeed.  See
  [docs/debug-notes/2026-10-01-test-templates-build-through-migrate-mjs.md](../../docs/debug-notes/2026-10-01-test-templates-build-through-migrate-mjs.md).
- Frontend tests (vitest) sit next to the code under `src/` and in
  `tests/`.  Add coverage when you add a non-trivial pure helper; UI
  behavior is mostly validated by visiting it.
- **To run a single backend test file**, `cd apps/backend && npx vitest run
  tests/foo.test.ts` — `pnpm --filter recycle-erp-backend test -- tests/foo.test.ts`
  silently drops the path and runs the full suite.

## Storage & OCR

- Label scans and sell-order attachments are uploaded to **Cloudflare R2**
  via the S3 SDK (`apps/backend/src/r2.ts`).  Public URL pattern:
  `R2_ATTACHMENTS_PUBLIC_URL/<key>`.  The base **must** include the
  `/<bucket>` segment when the R2 custom domain serves at `/<bucket>/<key>`
  (as `static.recycleservers.com` does).
- **Don't reintroduce Cloudflare Images** — it's paywalled (error 5453); we
  migrated everything to R2 attachments.  See [the AI-scan image design][2].
- **Model pickers read OpenRouter's public catalogue through
  `routes/aiModels.ts`** (`GET /api/ai/models`, manager-only): no key, trimmed
  to what a picker shows, cached in-process for an hour and served stale for
  five minutes at a time while OpenRouter is down.
- **OCR provider selection** lives in `apps/backend/src/ai/`.  OpenRouter
  (`openai/gpt-6-luna`, overridable with `OPENROUTER_OCR_MODEL`) when
  `OPENROUTER_API_KEY` is present; otherwise a deterministic stub that
  returns canned data.  Production refuses to boot without the key
  (`env.ts`); in dev and CI the stub logs one warning, and `/api/health`
  reports which one is live (`providers.ocr`).

[1]: ../../docs/superpowers/specs/2026-05-18-frontend-auth-overhaul-design.md
[2]: ../../docs/superpowers/specs/2026-05-12-ai-scan-image-preview-design.md
