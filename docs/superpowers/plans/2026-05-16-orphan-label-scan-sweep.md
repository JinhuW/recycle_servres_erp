# Orphan Label-Scan Sweep — Implementation Plan (DEFERRED)

> **Status: DEFERRED — do not execute yet.** Decision (2026-05-16): orphans are
> tolerated for now because R2 is pay-per-use and label JPEGs are tiny. Pick
> this up when orphan volume justifies it, or before a cost review.

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:executing-plans
> or superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Periodically delete *orphaned* label scans — `label_scans` rows (and
their R2 objects) whose `cf_image_id` is referenced by **no** `order_line`,
and which are older than a safety window — via a Cloudflare Cron trigger.

**Why this exists:** Every `POST /api/scan/label` creates a `label_scans` row
+ an R2 object under `label-scans/`. Only the scan attached to a saved line is
ever referenced; rescans and cancelled captures leave the rest unreferenced
forever. Attached-image cleanup is already done (line removal + order delete in
`src/routes/orders.ts`). This plan covers only the *never-attached* orphans.

**Architecture:** A pure `pruneOrphanLabelScans(env, { olderThanHours, limit })`
in `src/maintenance.ts`. Invoked two ways: (1) a Worker `scheduled` handler
(daily cron) — requires changing `src/index.ts`'s default export from the bare
Hono app to `{ fetch: app.fetch, scheduled }`; (2) an optional manager-only
`POST /api/maintenance/prune-label-scans` for ad-hoc runs. R2 deletes reuse
`deleteAttachment` from `src/r2.ts` (already no-ops `stub-` keys and absent
bucket). Order: pick a bounded batch → best-effort R2 delete each → delete the
DB rows. Crash-safe: a failed R2 delete leaves the row for the next run.

**Tech Stack:** TypeScript, Cloudflare Workers (Hono + `scheduled`), Vitest,
Postgres, R2 binding (`R2_ATTACHMENTS`).

**Spec:** none separate — design rationale is inline here.

**Working directory:** all paths under `apps/backend/`. Run commands there.

**Commit hygiene:** `main` carries unrelated WIP. Use explicit
`git add <paths>` — never `git add -A`.

---

## Correctness invariants (read before coding)

1. **Single reference table.** `order_lines.scan_image_id` is the *only*
   column that references `label_scans.cf_image_id` (migrations/0001_init.sql).
   Inventory is `order_lines` filtered by status — no extra table to check.
   Orphan ⟺ `NOT EXISTS (SELECT 1 FROM order_lines ol WHERE ol.scan_image_id = ls.cf_image_id)`.
2. **Age window is mandatory.** A user can rescan many times across minutes
   before the line is ever persisted; an in-progress draft order has no
   `order_lines` row yet. Only prune `ls.created_at < NOW() - INTERVAL
   'olderThanHours hours'`. Default **48h**. Never prune recent rows.
3. **Stub/legacy rows.** `cf_image_id` may be `stub-…` (no R2 object) or a
   legacy CF-Images id. `deleteAttachment` already no-ops `stub-` and missing
   objects (idempotent) — still delete the DB row.
4. **Bounded work.** Workers cap subrequests/CPU. Process a capped batch
   (default `limit = 200`) per invocation; the daily cadence drains backlog.
5. **R2 before DB.** Delete the object first (best-effort, catch+log), then the
   row. If R2 fails the row survives and retries next run (no dangling object
   with a deleted audit row).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/maintenance.ts` (create) | `pruneOrphanLabelScans(env, opts)` — query orphans, R2-delete, DB-delete; returns `{ scanned, deleted, r2Errors }`. |
| `src/index.ts` (modify) | Change `export default app` → `export default { fetch: app.fetch, scheduled }`; add `scheduled(event, env, ctx)` calling the prune via `ctx.waitUntil`. |
| `src/routes/maintenance.ts` (create, optional) | `POST /prune-label-scans` — manager-only, body `{ olderThanHours?, limit? }`, returns the stats. Mounted at `/api/maintenance` in `index.ts`. |
| `wrangler.toml` (modify) | Add `[triggers]\ncrons = ["17 4 * * *"]` (daily 04:17 UTC, off-peak). |
| `tests/maintenance.test.ts` (create) | Seeds: aged-orphan (deleted), referenced (kept), recent-orphan (kept), stub-orphan (row deleted, R2 skipped). Asserts fake-bucket `delete` calls + remaining rows. |
| `README.md` (modify) | One line documenting the sweep + cron. |

Single test file: `npx vitest run tests/maintenance.test.ts`. Full suite:
`npm test` (needs Postgres up + `TEST_DATABASE_URL`; run serially —
`fileParallelism:false` already set). Typecheck: `npm run typecheck`.

---

### Task 1: Prune module

**Files:** create `src/maintenance.ts`

- [ ] `pruneOrphanLabelScans(env, { olderThanHours = 48, limit = 200 } = {})`:
  - `SELECT id, cf_image_id FROM label_scans ls WHERE created_at < NOW() - (${olderThanHours} || ' hours')::interval AND NOT EXISTS (SELECT 1 FROM order_lines ol WHERE ol.scan_image_id = ls.cf_image_id) ORDER BY created_at LIMIT ${limit}`.
  - For each row: `await deleteAttachment(env, cf_image_id).catch(log → r2Errors++)`.
  - `DELETE FROM label_scans WHERE id = ANY(${ids}::uuid[])` (only ids whose R2 delete didn't throw, OR all — decide: delete all rows; a stuck R2 object is acceptable vs. an unbounded growing table. Recommended: delete all rows, log r2Errors).
  - Return `{ scanned, deleted, r2Errors }`.

### Task 2: Scheduled handler + export shape

**Files:** modify `src/index.ts`

- [ ] Add `async function scheduled(_event, env, ctx) { ctx.waitUntil(pruneOrphanLabelScans(env).then(s => console.log('label-scan sweep', s)).catch(e => console.error('sweep failed', e))); }`.
- [ ] Change `export default app;` → `export default { fetch: app.fetch, scheduled };` (verify all existing tests still import via `app.fetch` in `tests/helpers/app.ts` — they do; no test change needed).

### Task 3: Cron trigger

**Files:** modify `wrangler.toml`

- [ ] Add `[triggers]\ncrons = ["17 4 * * *"]`. Document that local `wrangler dev` won't fire it; test via the endpoint (Task 4) or `wrangler dev --test-scheduled`.

### Task 4 (optional): Manual endpoint

**Files:** create `src/routes/maintenance.ts`; modify `src/index.ts`

- [ ] Manager-only (`requireRole('manager')` per existing route guards) `POST /prune-label-scans`, parse `{ olderThanHours?, limit? }`, call the module, return stats JSON. Mount `app.route('/api/maintenance', maintenanceRoutes)`.

### Task 5: Tests

**Files:** create `tests/maintenance.test.ts`

- [ ] Insert directly into `label_scans` with controlled `created_at`
  (`NOW() - INTERVAL '3 days'` vs `NOW()`). Cases: aged orphan → row gone +
  `bucket.delete` called with its key; referenced (insert an `order_lines`
  with matching `scan_image_id`) → kept; recent orphan → kept; aged `stub-…`
  orphan → row gone, `bucket.delete` **not** called. Pass a fake
  `R2_ATTACHMENTS` via the env override (mirror `tests/scan-r2.test.ts`).
- [ ] If Task 4 done: one route test (manager 200 + stats; purchaser 403).

### Task 6: Docs + verify

- [ ] README one-liner. `npm run typecheck` clean. `npx vitest run
  tests/maintenance.test.ts` green. Full `npm test` green (serialized).
- [ ] Update memory [[cloudflare-images-unpaid-stubbed]] note: orphan sweep now
  exists (remove the "orphans accumulate" caveat).

---

## Rollout / observability

- Cron logs `{ scanned, deleted, r2Errors }` — visible in `[observability]`
  (already enabled in `wrangler.toml`). Watch the first few runs; if `deleted`
  is consistently near `limit`, raise `limit` or cadence until backlog clears,
  then it stays near 0.
- Reversibility: deleting an orphan row is safe by definition (referenced by
  nothing). The 48h window protects in-progress drafts; lower only with care.
