# Backend Line Reconciliation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Nothing is pushed to `origin/main` until Task 7 passes.

**Goal:** Fold the valuable, backend-only work from the divergent `worktree-backend-impl-prd-gaps` branch into `main` (the trunk) as additive, correctly-numbered migrations + new route/lib files + a ported test harness — without merging the branch and without disturbing main's frontend or its canonical shared route files. Then retire the branch.

**Architecture:** `main` is the trunk: it carries `origin/main` lineage, the entire frontend (mobile parity, desktop pages, warehouse, preferences, tweaks), the user's active work, and a backend that has already been patched for the 9 review findings. The parallel branch shares only the initial commit (`7ddf022`) with `main` and has **zero frontend updates**, so a git merge is excluded — it would conflict catastrophically and drag in a stale frontend. Instead we cherry-pick *forward* by hand: copy the parallel branch's net-new files, renumber its migrations into main's sequence (main already uses `0003`–`0010` for unrelated features), adapt feature code to main's actual query/route shapes, and port its test suite. The parallel branch's edits to *shared* route files (`dashboard`, `inventory`, `orders`, `sellOrders`, `me`, …) are intentionally **not** brought over — main's versions are canonical and frontend-aligned; their few valuable semantic deltas were already extracted in Phase 0.

**Tech Stack:** Hono 4 on Cloudflare Workers, postgres.js over Hyperdrive (PostgreSQL — *not* SQLite/D1), bcryptjs, R2 for object storage, React + TypeScript via Vite, Vitest 4 for backend tests. Migration runner `apps/backend/scripts/migrate.mjs` re-runs every `.sql` file in sorted order on each invocation, so **all DDL must be idempotent**.

**Spec:** None — this plan is self-contained. Source of truth for ported content is the `worktree-backend-impl-prd-gaps` branch (linked worktree at `.claude/worktrees/backend-impl-prd-gaps`, tip `8cc6814`).

---

## Phase 0 — Safety fixes (DONE, for context)

Already applied to main's working tree and typecheck-verified; do **not** redo:

1. PRD §6.8 cost-strip — `inventory.ts` (list + detail), `dashboard.ts` (leaderboard masking + `recent` strip)
2. Order lifecycle default `'draft'` / line `'Draft'` — `orders.ts` (route code only; the *column default* + backfill is still owed → Task 1)
3. Sell-order sellable-status + qty clamp — `sellOrders.ts`
4. Warehouse DELETE transfers `order_lines.warehouse_id` — `warehouses.ts`
5. `DesktopEditOrder` save-failure keeps editor open
6. `DesktopSellOrders` Total uses `order.total` + discount row
7. `preferences.tsx` ref-based rollback snapshot
8. `auth.tsx`/`lookups.ts` best-effort lookups
9. `DesktopInventoryEdit` sends `rpm`

These cover the *behavioral* deltas of parallel commits `64b885d`, `8a28d42`, `8cc6814`, `9aba99b`.

## Execution status (2026-05-15)

- **Task 1–3 (migrations):** Files created — `0011`–`0013`, `0015`–`0017`. `0014` skipped (Task 4 decision). `0015` made idempotent (added `UNIQUE(label)` — upstream `SERIAL`-only seed would duplicate under main's re-run-every-migration runner). `0013` seed extended with `HDD` to match main. **DB-apply verification (1.2/2.2/3.4) NOT run — no Postgres available.**
- **Task 4:** Decided — SKIP attachments (rationale recorded in Task 4 below).
- **Task 5:** Done — 6 files ported (`lib/{commission-calc,notify,pagination}.ts`, `routes/{categories,commission,workspace}.ts`), wired into `index.ts` (imports + authMiddleware + routes). Backend typecheck: **0 new errors** (still the 6-error pre-existing baseline). 5.4/5.5 deferred with rationale.
- **Task 6:** Done — `0017_indexes_pagination.sql` created; pagination wiring deferred (rationale below).
- **Task 7:** Harness ported (`vitest.config.ts`, `tests/**` incl. binary fixture, `package.json` scripts + `vitest`/`tsx`/`@types/node` devDeps). `tsconfig` only compiles `src/**` so specs don't affect typecheck. **BLOCKED:** spec adaptation (7.3) + the green-run gate (7.5) require a Postgres `TEST_DATABASE_URL` and `pnpm install`; none available in this environment.
- **Task 8 (optional UI un-stub):** Not started.
- **Task 9 (push):** **NOT done and will not be done** until Task 7.5 passes (per the plan's own gate).

**Blocker for the user:** provide a Postgres dev DB (`DATABASE_URL`) and test DB (`TEST_DATABASE_URL` in `apps/backend/.dev.vars`), run `pnpm install`, then: apply migrations, adapt the 16 specs to main's route shapes iteratively against the running suite (`pnpm --filter ./apps/backend test`), and only then proceed to Task 8/9.

## File Map

- **Create (migrations, renumbered into main's sequence):**
  - `apps/backend/migrations/0011_fix_lifecycle_default.sql`
  - `apps/backend/migrations/0012_audit_lock.sql`
  - `apps/backend/migrations/0013_categories.sql`
  - `apps/backend/migrations/0014_attachments.sql` *(decision gate — see Task 4)*
  - `apps/backend/migrations/0015_commission.sql`
  - `apps/backend/migrations/0016_workspace_settings.sql`
  - `apps/backend/migrations/0017_indexes_pagination.sql`
- **Create (backend source, copied from parallel branch then adapted):**
  - `apps/backend/src/lib/commission-calc.ts`
  - `apps/backend/src/lib/notify.ts`
  - `apps/backend/src/lib/pagination.ts`
  - `apps/backend/src/routes/categories.ts`
  - `apps/backend/src/routes/commission.ts`
  - `apps/backend/src/routes/workspace.ts`
  - `apps/backend/src/routes/attachments.ts` *(decision gate — see Task 4)*
- **Create (test harness, copied then adapted):**
  - `apps/backend/vitest.config.ts`, `apps/backend/tests/**` (16 specs + `helpers/*` + `fixtures/invoice.pdf`)
- **Modify:**
  - `apps/backend/src/index.ts` — wire new routes
  - `apps/backend/src/routes/notifications.ts` — upgrade 33-LOC stub via `lib/notify.ts`
  - `apps/backend/scripts/migrate.mjs` — add new tables to the `--reset` DROP list
  - `apps/backend/package.json` — add `test` script + vitest/tsx devDeps
  - `apps/frontend/src/pages/desktop/DesktopSettings.tsx` — un-stub categories + workspace *(Phase 4, optional)*
- **Do NOT touch:** shared route files (`dashboard.ts`, `inventory.ts`, `orders.ts`, `sellOrders.ts`, `me.ts`, `members.ts`, `market.ts`, `scan.ts`, `auth.ts`, `customers.ts`, `warehouses.ts`, `workflow.ts`, `lookups.ts`) beyond Phase 0; any frontend file beyond Phase 4.

## Tables that already exist on main (do NOT recreate)

`catalog_options, customers, inventory_events, label_scans, notifications, order_lines, orders, payment_terms, price_sources, ref_prices, sell_order_lines, sell_order_status_attachments, sell_order_status_meta, sell_order_statuses, sell_orders, users, warehouses, workflow_stages`.

Therefore parallel's `0005_sell_order_status_meta` is **redundant** (main's `0003_sell_order_status_meta` already provides it) — skip it. Genuinely new tables to add: `categories`, `attachments`, `commission_tiers`, `commission_settings`, `workspace_settings`.

## Verification baseline

Before Task 1, from repo root:

```bash
pnpm --filter ./apps/frontend typecheck   # expect: 0 errors
pnpm --filter ./apps/backend typecheck    # expect: ONLY the known pre-existing baseline
```

Record the backend baseline error list (bcryptjs missing types; `instanceof File` in `scan.ts`/`sellOrders.ts`; `reduce`/arithmetic on untyped `postgres` rows). No task may add a new backend error beyond this set.

---

## Task 1: Migration — fix lifecycle column default + backfill

**Files:** Create `apps/backend/migrations/0011_fix_lifecycle_default.sql`

Phase 0 fixed the route insert, but `0001_init.sql:36` still declares `lifecycle TEXT NOT NULL DEFAULT 'awaiting_payment'` and any rows seeded before the route fix are still wrong. Port parallel `0003_fix_lifecycle_default` verbatim (idempotent already):

- [ ] **Step 1.1:** Write `0011_fix_lifecycle_default.sql`:

```sql
-- Fix the default lifecycle for new orders. The original default
-- 'awaiting_payment' is not a value in workflow_stages, breaking transitions.
ALTER TABLE orders ALTER COLUMN lifecycle SET DEFAULT 'draft';
UPDATE orders SET lifecycle = 'draft' WHERE lifecycle = 'awaiting_payment';
```

- [ ] **Step 1.2:** `pnpm --filter ./apps/backend db:migrate` against a dev DB; confirm no error on a second run (idempotency).

## Task 2: Migration — audit-lock trigger (review issue #4)

**Files:** Create `apps/backend/migrations/0012_audit_lock.sql`

Port parallel `0009_audit_lock` verbatim. It uses `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`, which is idempotent under the re-run-every-time runner.

- [ ] **Step 2.1:** Write `0012_audit_lock.sql` with the `inventory_events_lock()` function and the `inventory_events_no_update` / `inventory_events_no_delete` triggers (exact DDL in parallel `apps/backend/migrations/0009_audit_lock.sql`).
- [ ] **Step 2.2:** Migrate; verify an `UPDATE inventory_events SET detail='x'` raises `inventory_events is append-only`, and an `INSERT` still succeeds.

## Task 3: Migrations — categories, commission, workspace_settings

**Files:** Create `0013_categories.sql`, `0015_commission.sql`, `0016_workspace_settings.sql`

All three are new tables with `CREATE TABLE IF NOT EXISTS` + `INSERT ... ON CONFLICT DO NOTHING` (idempotent). Port verbatim from parallel `0004_categories`, `0007_commission`, `0008_workspace_settings`.

- [ ] **Step 3.1:** Write `0013_categories.sql` (table `categories` + seed RAM/SSD/Other/CPU/GPU).
- [ ] **Step 3.2:** Write `0015_commission.sql` (`commission_tiers` + `commission_settings` + seeds). **Note the behavioral overlap:** main's `0002_desktop.sql:80` adds `users.commission_rate NUMERIC DEFAULT 0.075` and `dashboard.ts` hardcodes `* 0.075`. Introducing tiers does not by itself change dashboard math — Task 5 decides whether `dashboard.ts`/leaderboard adopt `commission-calc.ts`. This migration only adds the tables.
- [ ] **Step 3.3:** Write `0016_workspace_settings.sql` (`workspace_settings` key/value + seeds).
- [ ] **Step 3.4:** Migrate; re-run; confirm idempotent and seeds present.

## Task 4: DECISION GATE — attachments

**Files (conditional):** `0014_attachments.sql`, `apps/backend/src/routes/attachments.ts`

Main already has `sell_order_status_attachments` and a working sell-order attachment flow (`sellOrders.ts`, `0003_sell_order_status_meta`). The parallel branch adds a *generic* `attachments` table + `routes/attachments.ts`. These may be redundant on main.

- [x] **Step 4.1:** Compared. **DECISION: (a) SKIP.** `0014_attachments.sql` and `routes/attachments.ts` are removed from this plan.
- [x] **Step 4.2:** Rationale: Main already has the *superior, real* implementation. `apps/backend/src/r2.ts` performs actual R2 uploads with a dev stub fallback (`uploadAttachment`/`deleteAttachment`), and `apps/backend/src/routes/sellOrders.ts` exposes full per-status evidence CRUD (`POST /:id/status-meta/:status/attachments`, etc.) backed by the `sell_order_status_attachments` table with `storage_key`/`delivery_url`/mime/size/uploader. The parallel branch's `routes/attachments.ts` is self-described as `// v1: store metadata only — actual R2 upload deferred` against a generic `attachments` table not wired to any domain. Porting it would regress functionality. Skipped.

## Task 5: Port backend-only feature code

**Files:** Create `lib/commission-calc.ts`, `lib/notify.ts`, `lib/pagination.ts`, `routes/categories.ts`, `routes/commission.ts`, `routes/workspace.ts`; modify `index.ts`, `notifications.ts`.

Copy each file from the parallel branch, then adapt to main's reality (main's `orders`/`dashboard` query shapes, `Env`/`User` types, `getDb` signature, `r2.ts` helper for any storage).

- [ ] **Step 5.1:** Copy the 3 `lib/` files; fix imports/types to compile against main.
- [ ] **Step 5.2:** Copy `routes/categories.ts`, `routes/commission.ts`, `routes/workspace.ts`; adapt to main's middleware/auth (`c.var.user`, manager gating) and `getDb`.
- [ ] **Step 5.3:** Wire into `apps/backend/src/index.ts`:

```ts
app.route('/api/categories', categoriesRoutes);
app.route('/api/commission', commissionRoutes);
app.route('/api/workspace',  workspaceRoutes);
```

- [ ] **Step 5.4:** Upgrade main's `routes/notifications.ts` stub to use `lib/notify.ts` (keep main's existing `/api/notifications` + `/api/notifications/mark-read` contract that the frontend already calls).
- [x] **Step 5.5:** **DECISION: DEFER.** `dashboard.ts` keeps the flat `* 0.075` for now. Rationale: adopting tiered `commission-calc.ts` in the leaderboard is a behavioral change to a shared route that alters displayed commission figures and risks the Phase 0 PRD-§6.8 masking; it needs product sign-off. The `commission_tiers`/`commission_settings` tables and `/api/commission/*` endpoints are live for the Settings UI; the dashboard switch is a tracked follow-up (not in this reconciliation pass). Also note: main's `notifications.ts` is a correct minimal *consumer* endpoint, not a broken stub — `lib/notify.ts` is a *producer* helper. Wiring producers into `orders.ts`/`sellOrders.ts` (parallel commits `1116239`, `b442f10`) is deferred because it requires editing shared routes excluded by the File Map; `notify.ts` is ported as an available lib.
- [ ] **Step 5.6:** `pnpm --filter ./apps/backend typecheck` — no new errors beyond the recorded baseline.

## Task 6: Migration — pagination indexes

**Files:** Create `apps/backend/migrations/0017_indexes_pagination.sql`

Port parallel `0010_indexes_pagination` (3 `CREATE INDEX IF NOT EXISTS`). **Verify column existence on main first:** the index `notifications_user_unread_idx ON notifications(user_id, unread, created_at DESC)` assumes a `unread` column — confirm main's `notifications` schema (it may name it differently). Adjust the index to main's actual columns.

- [x] **Step 6.1:** Verified — main's `notifications` has an `unread BOOLEAN` column (`0001_init.sql:107`); `order_lines.part_number`/`status` and `sell_orders.created_at` exist. No column rename needed.
- [x] **Step 6.2:** `0017_indexes_pagination.sql` written verbatim (indexes valid against main's schema).
- [x] **Step 6.3:** **DECISION: DEFER wiring.** `lib/pagination.ts` is ported as an available lib, but wiring it into `/api/orders` is deferred: it requires editing the shared `orders.ts` route (excluded by the File Map) and main's frontend currently expects the existing non-paginated response shape — changing it risks a regression. The indexes are added now (harmless/additive); cursor pagination becomes a separate, frontend-coordinated change.

## Task 7: Port the test harness (gates the push)

**Files:** Create `apps/backend/vitest.config.ts`, `apps/backend/tests/**`; modify `apps/backend/package.json`.

This is the highest-effort task. The 16 specs were written against the parallel branch's route shapes and its migration set; they must be adapted to main's.

- [ ] **Step 7.1:** Copy `vitest.config.ts`, `tests/helpers/{app,auth,db,setup}.ts`, `tests/fixtures/invoice.pdf`. Adapt `helpers/db.ts` to main's migration files and `helpers/app.ts` to main's `index.ts` route wiring.
- [ ] **Step 7.2:** Add to `apps/backend/package.json`: `"test": "vitest run"` and the `vitest`/`tsx` devDependencies at the versions the parallel branch pins (see parallel `package.json` + commits `ca49e18`, `cb8a771`, `38e4f1b`).
- [ ] **Step 7.3:** Port specs one domain at a time, adapting expectations to main's responses: `smoke` → `auth` → `orders` → `inventory` (assert PRD §6.8 strip) → `sell-orders` (assert sellable/qty validation) → `dashboard` (assert leaderboard masking) → `categories` → `commission` → `workspace` → `notifications` → `pagination` → `attachments` (only if Task 4 chose port).
- [ ] **Step 7.4:** Add regression tests for the Phase 0 fixes that lack one (warehouse DELETE FK transfer; `preferences` rollback; lifecycle default).
- [ ] **Step 7.5:** `pnpm --filter ./apps/backend test` — **all green**. This gates Task 9.

## Task 8 (optional, Phase 4): Un-stub the frontend

**Files:** Modify `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

- [ ] **Step 8.1:** Replace the hard-coded category list (`DesktopSettings.tsx:194`) with a fetch to `/api/categories`.
- [ ] **Step 8.2:** Replace the local-only workspace fields (`DesktopSettings.tsx:289`) with `/api/workspace` GET/PATCH.
- [ ] **Step 8.3:** `pnpm --filter ./apps/frontend typecheck` — 0 errors.

## Task 9: Commit, push, retire the branch

- [ ] **Step 9.1:** Update `apps/backend/scripts/migrate.mjs` `--reset` DROP list to include `categories`, `commission_tiers`, `commission_settings`, `workspace_settings` (+ `attachments` if Task 4 chose port).
- [ ] **Step 9.2:** Confirm `.claude/` and `apps/frontend/tsconfig.tsbuildinfo` are excluded from the commit (add to `.gitignore`).
- [ ] **Step 9.3:** Final gate: frontend typecheck 0 errors; backend typecheck == baseline; `pnpm --filter ./apps/backend test` all green.
- [ ] **Step 9.4:** Commit the working tree in coherent commits; push `main` → `origin/main`.
- [ ] **Step 9.5:** After confirming parity, remove the worktree and delete the branch:

```bash
git worktree remove .claude/worktrees/backend-impl-prd-gaps
git branch -D worktree-backend-impl-prd-gaps
```

## Risks & notes

- **Migration runner re-runs everything every time** — every new file must stay idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `CREATE OR REPLACE` + `DROP ... IF EXISTS`).
- **Commission model overlap** — main has a flat `users.commission_rate` (0.075); parallel introduces tiers. Adopting tiers in `dashboard.ts` is a behavioral change; keep it isolated and keep Phase 0 PRD-§6.8 masking.
- **Pagination response shape** — main's frontend currently expects the existing `/api/orders` shape; make cursor pagination opt-in to avoid breaking it.
- **Tests are the long pole** — they assume parallel's schema/routes; budget the most time for Task 7.
- **No git merge, ever** — the branches share only the root commit; reconcile by hand-porting as above, then delete the branch.
