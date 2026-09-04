# Recycle Servers ERP — Conventions

Read [README.md](./README.md) first for the what.  This file is the how:
the conventions, quirks, and tripwires that aren't obvious from the code.

## Workspace

- **pnpm only** — `packageManager` is pinned to `pnpm@11.0.9` and the lockfile
  is `pnpm-lock.yaml`.  Don't introduce `package-lock.json` or `yarn.lock`.
- Workspaces are declared in `pnpm-workspace.yaml`: `apps/*` and `packages/*`.
- **Every code push to `dev` bumps the root `package.json` version** (patch
  for fixes, minor for features). CI (`.github/workflows/version-check.yml`)
  fails the push if code under `apps/`, `packages/`, or `deploy/` changed
  since the latest `v*` tag without a bump, and auto-tags `v<version>` on
  green. Docs-only pushes are exempt.
- Common entry points from the repo root:
  - `pnpm dev` — runs backend (`:8787`) and frontend (`:5173`) in parallel.
  - `pnpm typecheck` / `pnpm build` — recursive across the workspace.
  - `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` — proxy to backend
    scripts.
  - `pnpm --filter recycle-erp-backend test` (vitest, integration) and
    `pnpm --filter recycle-erp-frontend test`.
- The `@recycle-erp/shared` package is imported as a workspace dep (`main:
  "./src/index.ts"`) — there's no build step.  Don't add one.

## Tickets, changelog & features

Three documents carry the project's memory.  `docs/tickets/` says what was
asked, `CHANGELOG.md` says when it shipped, `docs/FEATURES.md` says what the
system does today.  Read `docs/FEATURES.md` first when you don't know this
codebase.

1. **A change request becomes a ticket** in `docs/tickets/` —
   `scripts/ticket.sh new "<title>"`.  Because `plan-first` governs this repo,
   the ticket is *drafted inside plan mode* and shown as part of the plan, then
   written as the first step of implementation.  The `## Ask` block is the
   requester's own words, **verbatim** — that field is the only thing in the
   file that can't be reconstructed from the code later.  The `ticket-workflow`
   skill in `.claude/skills/` covers the rest; `/ticket` is the manual path.
2. **The version bump that ships it adds a `## [X.Y.Z]` section to
   `CHANGELOG.md` in the same push.**  `version-check.yml` fails the push
   otherwise.  `scripts/changelog.sh draft` prints a starting point from the
   branch's commits; rewrite it into prose — what changed and why it mattered,
   not the commit subject again.
3. **If user-visible behaviour changed, edit `docs/FEATURES.md`** and cite the
   new version.  Nothing enforces this one, which is exactly why it needs
   saying: it is the document that rots first.
4. **Close the ticket** — `scripts/ticket.sh status RS-nnn done`, and fill its
   `pr:` and `version:` fields.  `version:` is the join back to the changelog.

Three things worth knowing:

- **A version collision renumbers the changelog header too.**  When another
  session takes the version you bumped to, the fix is a fresh bump *and* a
  renamed `## [X.Y.Z]` heading — the CI gate matches the header against
  `package.json` exactly.
- **`version-check.yml` runs on `dev` and `main`, but only `dev` creates
  tags.**  A hotfix pushed straight to `main` gets the same bump + changelog
  demand; the tag is created when the version reaches `dev`, because a tag
  minted on a `main` commit would make the back-port fail "tag exists on an
  unrelated commit".  `LAST_TAG` is the newest tag *reachable from HEAD*
  (`--merged HEAD`) — on `main`, which runs several releases behind, the global
  newest tag would fail every push including docs-only ones.
- **The `docs/FEATURES.md` check is a `::warning::`, never a failure.**  A
  release carrying `feat()` commits that doesn't touch it gets an annotation.
  Whether a change altered user-visible behaviour isn't machine-decidable, and
  a gate that produces false blocks gets cleared by touching the file for no
  reason.
- `scripts/changelog.sh backfill` rebuilds the whole file from the tag list and
  is idempotent.  It preserves hand-written sections verbatim, so running it
  is safe — but it is a repair tool, not part of the release flow.
  `scripts/release.sh` has its own, older generator for the retired
  Docker/`main` flow; don't extend that one.

## Session isolation (one branch per Claude Code session)

Several Claude Code sessions run against this repo at once, so **every session
works on its own branch inside its own git worktree**.  A single shared checkout
can only have one branch checked out; without this, a second session silently
switches the branch out from under the first.

- **Start sessions with `scripts/new-session.sh`.**  It branches off
  `origin/dev`, creates a worktree under `.claude/worktrees/`, copies `.env`,
  runs `pnpm install`, and launches `claude` inside it.  Optional branch name:
  `scripts/new-session.sh feat/<topic>` (default `session/<timestamp>`).
- **To pick work back up, `scripts/new-session.sh --checkout <branch>`.**  It
  puts an *existing* branch in a worktree instead of cutting a new one — local
  or remote-only (`origin/<branch>` is fetched and tracked, and either spelling
  is accepted).  The branch is taken as it stands: never rebased, never reset
  onto `origin/dev`.  If a session worktree already holds that branch, that
  worktree is handed back with its uncommitted work intact, unless a live
  session is still in it.  Because git allows a branch in only one worktree,
  a branch checked out in the main checkout is refused rather than stolen.
- **Sessions launched by `scripts/new-session.sh` run with permission prompts
  off**, because it execs `claude --dangerously-skip-permissions`.  The
  `permissions.defaultMode: "bypassPermissions"` in `.claude/settings.json` is
  no longer what does it: **from CLI 2.1.257 that mode is ignored when it comes
  from project or local settings** (user or managed settings only).  It is left
  in place for older CLIs.
- **A session that arrives via `EnterWorktree` therefore keeps its prompts** —
  permission mode is fixed at launch, and the `--print-only` path never execs
  `claude`.  Covering that one means a user-scope `defaultMode` in
  `~/.claude/settings.json`, which applies to every project on the machine.
  See [docs/debug-notes/2026-09-04-project-bypass-permissions-ignored.md](./docs/debug-notes/2026-09-04-project-bypass-permissions-ignored.md).
- The worktree isolates the *branch*, not the machine: bypass mode still permits
  any shell command, any file outside the worktree, and pushes to any remote.
  To get prompts back, drop the flag from the `exec` line in
  `scripts/new-session.sh`.
- **If a session starts in the main checkout anyway**, the `SessionStart` hook
  in `.claude/settings.json` (`scripts/claude-session-hook.sh`) says so.  The
  agent should then run `scripts/new-session.sh --print-only` and call
  `EnterWorktree` with the path it prints.  Read-only sessions — answering a
  question, reading history, no file edits — can skip this.
- The base ref is **always `origin/dev`, never `main`**, matching the normal
  branch workflow.  Claude Code's own `worktree.baseRef` setting can't express
  this (it only offers `origin/<default-branch>`, i.e. `main`, or local HEAD),
  which is why creation is scripted rather than left to `EnterWorktree`.
- **Worktrees are recycled, not accumulated.**  Starting a session reuses an
  idle slot (resetting it onto a fresh branch, keeping its `node_modules` so
  startup stays a few seconds) and sweeps any other idle slots, so abandoned
  sessions cannot pile up at ~290 MB each.  `--fresh` forces a new one.
- A slot counts as idle only if it is clean, on a branch, holds nothing that is
  not already in `origin/dev`, **and** carries a lock file from a session that
  has since exited.  Locks live in `.claude/worktrees/.locks/` (outside the
  checkouts, so they don't show up as untracked files): the launcher records the
  PID that `exec claude` inherits, and the `--print-only` path records a
  timestamp that expires after 8h.  A worktree with **no** lock is never touched
  automatically — it predates the mechanism or was made by hand, so whether
  someone is sitting in it is unknowable.
- `scripts/new-session.sh --prune` reclaims idle slots on demand and `--list`
  shows each one's state without touching anything.  Prune keeps — never
  removes — a worktree that has uncommitted changes, is on a detached HEAD, is
  held by a live session, or that you are currently standing in.  It *will*
  remove a clean, fully-merged, unlocked worktree, so a session that was
  created outside the launcher should be given a lock file if you want it
  protected.
- **Prune compares file content against `origin/dev`'s history, not commit
  ancestry and not dev's tip.**  PRs land on `dev` as squash commits, so a
  session branch's own commits are never ancestors of `origin/dev`; an
  ancestry test (`git log origin/dev..HEAD`) would report every worktree as
  unmerged forever.  Comparing against dev's *tip* rots almost as fast:
  every PR bumps `package.json`, so any later merge makes an already-merged
  worktree mismatch permanently.  The check therefore looks for the branch's
  final blobs anywhere in `merge-base..origin/dev` (the squash commit carries
  them verbatim).  See
  [docs/debug-notes/2026-07-26-prune-ancestry-vs-squash-merge.md](./docs/debug-notes/2026-07-26-prune-ancestry-vs-squash-merge.md)
  and
  [docs/debug-notes/2026-08-23-prune-content-check-rots-as-dev-advances.md](./docs/debug-notes/2026-08-23-prune-content-check-rots-as-dev-advances.md).
- `.claude/` is gitignored **except** `settings.json`, so the hook config is
  shared but worktrees and `settings.local.json` are not.

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
- **`orders.category` and `orders.total_cost` are derived from the lines**, by
  `services/orderCategory.ts` and `services/orderGoodsTotal.ts`, at the end of
  every transaction that writes lines.  **Clients must not send `totalCost`** —
  the API still accepts it, but a value there is read as a *negotiated lot
  price* and pins the column against the lines from then on.  The mirror /
  negotiated verdict has to be read *before* the line writes
  (`goodsTotalIsMirror`); afterwards a stale mirror and a real override are
  indistinguishable.
- **Upload validation** — `routes/attachments.ts` enforces both
  `maxBytes` and `allowedMime` from `lib/settings.ts → getUploadLimits()`.
  The allowed set is intersected with `SAFE_UPLOAD_MIME` so a misconfigured
  DB setting can't widen the surface.  Keep it that way.
- **Migrations** are plain SQL under `apps/backend/migrations/`, numbered
  `NNNN_…sql`.  The backend runs them on startup via `scripts/migrate.mjs`,
  recorded in `schema_migrations`.  Always add the next number; never edit
  a migration that's been deployed.

## Auth & CSRF

- httpOnly `at` (15-min JWT) + `rt` (rotating refresh family) cookies.  No
  `localStorage`, no bearer tokens.  See [auth_cookie_model.md][1] in memory.
- Every mutating request must carry `X-Requested-By: recycle-erp` (the
  `csrfGuard` middleware drops it otherwise with 403).  Exempt: safe methods,
  `/api/health`, and `/api/public/*` (the unauthenticated vendor endpoints
  — they use URL tokens, not cookies, so CSRF doesn't apply).
- Refresh-token reuse revokes the whole family.  Don't relax that.

## MCP & OAuth (connectors)

- `/api/mcp` is **Bearer-only and CSRF-exempt**, mounted with
  `bearerGuard({ scopes: [] })` — it requires a *valid* token, nothing more.
  Per-tool gating lives in `TOOL_SCOPES` (`src/mcp/server.ts`) and filters both
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
- `/oauth/authorize` accepts only the 15-min `at` cookie and bounces to
  `/login?next=…`.  The SPA **must** honour `next` (`readSafeNext` in
  `lib/route.ts`, consumed in `DesktopApp.tsx`/`MobileApp.tsx`) or the connector
  popup dead-ends on the dashboard.

## Database & migrations

- Postgres 16.  The highest-numbered file in `apps/backend/migrations/` is
  the head.
- FKs use `ON DELETE` rules added in `0041_fk_on_delete.sql`.  When adding
  a new child table, declare the rule explicitly; don't rely on default
  `NO ACTION`.
- FK indexes are managed in `0035_fk_indexes.sql` and `0040_perf_indexes.sql`.
  When you add a FK, add the matching index in the same migration.

## Tests

- Backend tests are **integration tests against a real Postgres** — they
  exercise the real SQL, migrations, FK rules, and status guards (the layer
  most likely to break), so the DB dependency is intentional, not a smell.
  They need `127.0.0.1:5432` reachable — `docker-compose.override.yml` does
  that for local dev.  Production compose doesn't ship the override.
  CI runs them against a `postgres:16` service container
  (`.github/workflows/backend-tests.yml`), which must set `TEST_DATABASE_URL`
  in the job env: `global-setup.ts` otherwise falls back to the repo-root
  `.env`, which doesn't exist on a runner, and throws.
- **Test files run in PARALLEL** (`vitest.config.ts`: `pool: 'forks'`, files
  parallel, `maxForks` 8 by default — override with `VITEST_MAX_FORKS`).  Each
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
- Frontend tests are sparse (~6 files).  Add coverage when you add a
  non-trivial pure helper; UI behavior is mostly validated by visiting it.
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
  stdout-only.  Records are version/commit-stamped by `appendErrorRecord`
  itself — callers never pass them.  See `apps/backend/src/lib/error-log.ts`.

## Cloudflare Worker deploys

- Deploy the frontend Workers with `deploy/cloudflare/deploy.sh <prod|dev>` —
  it builds, deploys, and smoke-checks every public hostname through
  Cloudflare. Don't run bare `wrangler deploy`.
- **Every public hostname must be declared in `wrangler.toml` routes**
  (`custom_domain = true`). Deploys reconcile custom domains against the
  file; a domain attached only via the CF dashboard gets its DNS record +
  cert deleted by the next deploy → sitewide 523 while Railway stays green.
  See `docs/debug-notes/2026-07-13-cloudflare-worker-custom-domain-deleted.md`.
- Pushes to `main` and `dev` auto-deploy their Worker via
  `.github/workflows/deploy-frontend.yml` (needs `CLOUDFLARE_API_TOKEN` repo
  secret); the branch picks the target (`main` → prod Worker). The Railway
  production environment also tracks `main` (the `prod` branch is retired,
  2026-07-20), so a `dev`→`main` merge is a full release. The `uptime-monitor` Railway cron
  (`deploy/railway-uptime/`) probes prod every 5 min as the backstop.

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

- What the system does today, by area: `docs/FEATURES.md`.
- What was asked, and by whom: `docs/tickets/` (index in `INDEX.md`).
- What shipped when: `CHANGELOG.md` — one section per `v*` tag.
- Per-feature design docs: `docs/superpowers/specs/`.
- Implementation plans (in-flight and finished): `docs/superpowers/plans/`.
- Auto-memory referenced above lives under
  `~/.claude/projects/-srv-data-recycle-erp/memory/`.

[1]: docs/superpowers/specs/2026-05-18-frontend-auth-overhaul-design.md
[2]: docs/superpowers/specs/2026-05-12-ai-scan-image-preview-design.md
[3]: docs/superpowers/specs/2026-05-16-docker-migration-design.md
[4]: docs/superpowers/specs/2026-05-17-cloudflare-terraform-module-design.md
[5]: docs/superpowers/specs/2026-05-17-per-order-commission-rate-design.md
