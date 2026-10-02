> **For agentic workers:** execute batch by batch; each batch is its own ticket, worktree (PID lock) and PR. Phase 0 and every ops-track row need the user's explicit go-ahead.

> Ask (2026-10-02): "ultrathink all these remaing works, create an detailed implementation plan to achieve the remaining items."

# Remaining code-review work: implementation plan (Batches 3–8 + ops track)

## Context
The 2026-10-01 full review found 3 Critical, 40 Major and ~46 Minor issues.

**Done so far:**
- **v1.191.0 (RS-130):** C1–C3, M1, M11, M19, M29, and the vendor portal removed.
- **v1.193.0 (RS-134):** every Minor, plus M16.
- **M17 is obsolete.**

You asked for a detailed plan to finish the rest. Three Explore agents re-confirmed all **32 open Majors** against `origin/dev` @ 32ab7160 (v1.194.0), with file:line evidence. This plan groups them into batches, plus a gated ops track and a few loose ends.

**Your decisions (2026-10-02):**
- Connectors: show the redirect host and an "unverified" badge, with no approval gate.
- Form spam: budgets and purge, no CAPTCHA.
- Prod→dev copy: scrub secrets, keep password hashes.
- Layout: picked once per page load, with a "Switch layout" button.

**Prod facts (read-only, 2026-10-02):**
- **Data the constraints need:** 0 lines with `unit_cost < 0`; 0 suppliers whose compressed name is empty; 0 lines below their committed qty.
- **Payments:** all 145 PayPal rows are USD. One unpaired payment is linked on both legs.
- **Sell orders:** all 35 Done orders have a status-meta row and a `status_changed` event.
- **Pinned totals:** 12 POs have `total_cost` ≠ line sum. Most are real lot prices; PO-1339 is the known $8.5k empty shell.
- **Connectors:** the only live OAuth client is "Claude" (self-registered, all four scopes).
- **CORS:** prod's `CORS_ALLOWED_ORIGINS` includes the three marketing origins.
- **Images:** every stored image URL is on `https://static.recycleservers.com`. Dev uploads go to `https://pub-01be3c247eb8470fb80dfe80494362f7.r2.dev`.
- **Desk scanner:** the bridge is `http://127.0.0.1:47811`.
- **New finding: every `login_attempts.ip` is a Cloudflare egress address.** The last 30 days hold only 24 distinct IPs (104.22.x, 172.68.x, 162.159.x), shared across users. Railway rewrites the forwarded IP the Worker sets. So **every per-IP limit today keys on Cloudflare's servers**, the public-form 5/min limiter included. Batch 3a fixes this first.

## Ground rules for every batch
1. **Its own worktree, with a PID lock.** Not `claimed:<ts>`: that expires after 8h, and it is how this session's worktree was swept. Run `git branch --show-current` before every commit.
2. **One ticket per batch,** with your message quoted in `## Ask`. Check ticket, version and migration numbers against origin/dev, sibling worktrees and open PRs right before the commit. If a peer has a PR in flight, take two numbers above it.
3. **Check prod data before adding any constraint** (read-only). Data fixes go through guarded migrations.
4. **Implementation is mostly mine, done in sequence.** Subagents only get small, disjoint mechanical tasks, and they write test files in pieces (Batch 2 hit the 600s stall watchdog three times).
5. **Tests:**
   - While working: targeted runs, `cd apps/backend && VITEST_MAX_FORKS=2 npx vitest run tests/<f>.test.ts`.
   - Before the PR: the full suites and `pnpm typecheck && pnpm build`.
   - CI runs on PG18. Migrations must also run on the local PG16, so no PG17-only DDL.
   - Bump the version before or after a full run, never during one.
6. **The `verify` skill for anything user-visible:** a local stack on a scratch DB, plus `inventory-dev` after the merge.
7. **Shipping:** PR → squash to dev → close the ticket → check dev health. Every prod release needs your go-ahead. Each batch ships CHANGELOG prose, FEATURES.md and debug notes.
8. **Deploy skew:** the Worker and Railway deploy independently. New response fields are read with `?.`. A backend that depends on a new Worker header falls back when the header is missing.

## Phase 0 — release v1.191.0 → v1.194.0 to prod (needs your explicit go-ahead)
Prod still has the transfer phantom-stock bug and the open-redirect bug, and still serves the vendor portal. The release carries:
- 0141: already applied by hand, idempotent.
- 0142: drops the vendor tables. Prod has 0 bids.
- 0143: payment CHECK; prod data is clean.
- 0144–0146: additive columns.
- Code checks at boot: `JWT_SECRET` and `PROXY_SECRET` are 64 chars on prod, so the new checks pass.

Follow the dev→main release flow:
1. Release PR merged with `--merge`.
2. Poll prod `/api/health` for 1.194.0.
3. Confirm the main workflow runs.
4. Smoke-test login, the PO list, a transfer, sell orders and OAuth discovery.

**Recommended before Batch 3.**

## Batch 3a — Worker and edge headers (frontend pipeline) → patch bump
**Real client IP (prerequisite for M10/M3/M5).**
- `deploy/cloudflare/worker.js:92` also sets a private `X-Client-IP` from `CF-Connecting-IP`, the same pattern as `X-Public-Host`, which Railway passes through.
- The backend reads it in Batch 3b, falling back to the first `X-Forwarded-For` entry when it is missing (deploy skew, local dev).

**M9 — security headers.**
- The whole set goes in `apps/frontend/public/_headers` under `/*`. A live check on dev shows `_headers` already applies to responses the Worker fetches from `env.ASSETS` (`/sw.js`) and to the SPA fallback built from them (it carries HSTS). The Worker only needs to inject if it builds a response from scratch, and then it uses `set`, never `append`.
- The set:
  - `Content-Security-Policy-Report-Only: <CSP>` for one release, then `Content-Security-Policy`
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`
  - `Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()`
  - HSTS, which is already present
- CSP, with both R2 origins in one policy (the prod DB is copied nightly to dev, so dev shows both): `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https://static.recycleservers.com https://pub-01be3c247eb8470fb80dfe80494362f7.r2.dev; media-src 'self' blob:; connect-src 'self' https://static.recycleservers.com https://pub-01be3c247eb8470fb80dfe80494362f7.r2.dev http://127.0.0.1:47811; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
  - Checked as needed: no inline scripts (the boot script is a hashed asset), self-hosted fonts, zxing/@jsquash WASM, about 2,300 inline `style` props, consent via `location.href`, no iframes or `window.open`, `audio:false` cameras.
- **Service-worker trap:** `sw.ts:14` serves every navigation from the precached `/index.html`, together with the headers cached alongside it, and the precache only refreshes when index.html's bytes change. So:
  - every CSP change also changes index.html (a `<meta name="csp-rev">`);
  - verification uses a page load the service worker controls, not just `curl -I`.
- Update or delete the stale CSP in `apps/frontend/Caddyfile:11`. Its `connect-src 'self'` would block the bridge and the R2 fetch at `linePhotos.ts:286`.
- Verify on `inventory-dev`: during the report-only release, read the console while exercising login, PO images, the RAM-sheet/QR scan (WASM), the desk-scanner bridge, xlsx and packing-list downloads, PWA registration and update, and OAuth `/authorize`. Once that's clean, switch to enforced.

## Batch 3b — backend public-surface hardening → minor bump
**M10 — client IP and the limiter.**
- New `apps/backend/src/lib/clientIp.ts` reads `X-Client-IP`, falling back to the first `X-Forwarded-For` entry. It returns `{ full, key }`, where `key` is the IPv6 /64 or the IPv4 address. It replaces the 4 copies in `publicForms.ts:88`, `routes/auth.ts:29`, `routes/me.ts:147` and `oauth/server.ts:106`.
- `login_attempts.ip` keeps the full address; only limiter keys use `key`.
- `lib/rate-limit.ts`: a lazy sweep on insert (drop expired keys every Nth call), delete keys whose list empties, and a hard cap of 50k keys.
- Unit tests: eviction, the cap, /64 grouping, and header precedence.

**M6 — CORS split.** `apps/backend/src/index.ts:156-191`.
- A route-scoped `cors()` covers **exactly** `/api/public/intake` and `/api/public/quote`:
  - `credentials:false`, POST/OPTIONS, `Content-Type`, `exposeHeaders: ['Retry-After']`
  - origins from a code default (ram4cash.com, www.ram4cash.com, recycleservers.com, www.recycleservers.com), overridable by `PUBLIC_FORM_ORIGINS`
- The global `cors()` skips those two exact paths; the Shippo webhook under `/api/public/shippo` is untouched. Without the skip, the global middleware would add `ACAC: true` before `next()`.
- Callers: `ram4cash/src/lib/intake.ts:72` (multipart, reads `ref` and `Retry-After`) and `home_page/src/components/pages.tsx:290` (JSON, preflights).
- **Ops, after the prod deploy (your go-ahead):** remove the three site origins from prod `CORS_ALLOWED_ORIGINS`, keeping the canonical host first.
- Tests (`tests/cors.test.ts`): a site preflight gets ACAO and no ACAC; a site origin on `/api/orders` gets no ACAO; the SPA origin keeps credentials.

**M4 — intake resource limits.**
- `index.ts` `isUploadPath` gives `/api/public/intake` its own 25 MiB cap.
- `publicForms.ts`: a per-photo raw cap of 15 MiB → 413.
- `lib/image-shrink.ts`:
  - `sharp(input, { limitInputPixels: 40e6, autoOrient: true })` on both calls (sharp 0.35);
  - a metadata pixel check before the loop;
  - a `{ strict }` option, so the public path answers 400 while authenticated callers keep "fall back to the original";
  - a process-wide semaphore of 2.
- Tests: a large-pixel refusal with a lowered `maxPixels`; concurrency stays at 2 or below.

**M5 — budgets and purge.**
- A DB-backed global daily budget in `publicForms.ts`: 300 submissions or 2 GB per UTC day → 429 + Retry-After. Both numbers are workspace settings.
- The per-IP limit keys on `clientIp().key`.
- `startWebSubmissionPurgeLoop` (the `startFxRefreshLoop` shape, `lib/fx.ts:147`) runs daily: it takes `status IN ('spam','archived') AND updated_at < now()-30d`, calls `deleteAttachments` (`r2.ts:210`), then deletes the rows (photos cascade; converted POs own copies). It's started in `server.ts` with its `{stop}` kept for Batch 4.
- Tests: the 429 budget; the purge's selection and R2 key list (stub).

**M3 — login throttle.** `routes/auth.ts:36-88`, `routes/me.ts:155-171`.
- Migration: `login_attempts.success DROP NOT NULL` + `INDEX (ip, attempted_at)`.
- Flow:
  1. Reserve a pending row (`success NULL`).
  2. Count with `success IS NOT TRUE`, excluding the caller's own row id, so 5 failures are still allowed.
  3. bcrypt.
  4. `UPDATE success`.
- The reservation is **deleted** on a 429, on a bcrypt-gate 503, and on any throw (try/finally), so refused attempts never lengthen the lockout.
- `me.ts` gets the same count change.
- A per-IP failure budget of 30 per 15 min, keyed on the **real** client IP from 3a. It is safe only once `X-Client-IP` is live; until then the budget is skipped when the header is missing.
- `lib/bcryptGate.ts`: at most 4 concurrent bcrypt ops, a 5s queue, then 503. Used by `verifyPassword`, `hashPassword` and `oauth/clients.ts`.
- `/oauth/token` and `/oauth/revoke` get a per-client and per-IP limiter before the secret compare.
- Tests:
  - 20 parallel bad logins give at most 5 failed rows and the rest 429, with no leftover pending rows;
  - the per-IP budget holds across emails;
  - the token limiter;
  - the password-change throttle is unchanged.

**M2 — consent shows who it is.**
- `oauth/server.ts:621-643` `/authorize/pending` adds `redirectHost` and `selfRegistered` (`created_by IS NULL`).
- `Authorize.tsx` shows "You'll be sent to **{host}**" and an "Unverified: registered by the app itself" badge. It reads both with `?.` because the Worker ships first.
- The admin client list (`server.ts:652`) adds `redirectUris` and `selfRegistered`; `DesktopSettingsConnectors.tsx` shows both. i18n en/zh.
- Known edge: `created_by` is `ON DELETE SET NULL` (`0046:10`), so a manager-made client whose creator is deleted shows as Unverified. That's acceptable.
- Backend test for the fields.

## Batch 4 — ops and tooling → patch bump
**M31 — graceful shutdown.**
- First confirm (read-only, Railway) that the backend service has **no dashboard start command** overriding the Dockerfile `CMD`; there is no backend `railway.toml`.
- `apps/backend/Dockerfile:65` → `… && exec node --import tsx src/server.ts` (tsx ^4.21 is a production dependency).
- New `lib/shutdown.ts` `onShutdown({ server, loops, closeDb, graceMs: 20_000, hardMs: 25_000 })`:
  - stop the loops;
  - `server.close()`; after the grace period, `server.closeAllConnections()`, because long-lived MCP connections would hold close open;
  - `closeSharedDb()`, then exit 0, with a hard exit at the deadline.
- `server.ts` keeps the server and every loop's `{stop}`.
- Update the comment in `tests/log-import-purity.test.ts:8`. Unit-test the helper with fakes.
- Ops (your go-ahead): set the Railway draining window to about 30s on prod and dev.

**M32 — CI filters.**
- `backend-tests.yml:25-35` and `deploy-frontend.yml:17-21` add `pnpm-lock.yaml`, `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.npmrc` and `.nvmrc`.
- `version-check.yml:51` adds the same plus `backup infra`.

**M33 — `scripts/new-session.sh`.**
- A `mkdir` mutex under `.locks/` around selection → claim.
- The claim is written immediately after selection (today it happens after `create_session`, :545/:557).
- Liveness also treats a slot as busy when any process has its cwd inside it (`pgrep` + `lsof -a -d cwd -p`).
- `scripts/claude-session-hook.sh` writes the claude PID as the lock when a session enters a worktree, so long sessions never expire.
- Manual test: two concurrent `--print-only` runs, and `--prune` with a live process in a slot.

**M8 — destructive-script guard.**
- `scripts/seed.mjs` and `migrate.mjs --reset` refuse unless the host is `localhost`, `127.0.0.1`, `::1` or `postgres`, or `ALLOW_DESTRUCTIVE_SEED=true`. They print the target host.
- Test: a spawn with a host of `db.example.invalid` exits 1 before connecting.

**M7 — prod→dev sync.**
- New `deploy/railway-sync/scrub.sql`, run by `sync.sh` inside the same restore transaction:
  - `TRUNCATE refresh_tokens, oauth_refresh_tokens, oauth_authorization_codes, oauth_pending_consent, login_attempts`
  - `UPDATE oauth_clients SET secret_hash = NULL, revoked_at = NOW()`
  - password hashes are kept.
- **A backend test runs `scrub.sql` against the migrated template DB,** so a future FK onto these tables fails CI rather than the nightly `ON_ERROR_STOP` restore.
- Fix the stale `--clean` text in `docs/deployment-railway-dev-prod.md:103-112`.
- **Ops (your go-ahead):** create `prod_reader` with `pg_read_all_data` on prod (a one-off with a generated password, never a migration, because roles are cluster-wide). Point the dev sync's `PROD_DATABASE_URL` at it.

## Batch 5 — stock math and lock order → minor bump
**M40 — one free-quantity rule.**
- `lib/sellCommitment.ts` gains:
  - `committedQtyLateral(sql, lineAlias)` (SQL fragment);
  - `committedQtyByLine(tx, ids)` → `Map`;
  - `committedLineIdsTx(tx, ids, statuses)` for the EXISTS-style callers.
- No `archived_at` filter: archiving a committed sell order is refused (`sellOrders.ts:1539`), and so is moving an archived one into a committed status (`:1297`).
- Replace:
  - `validateSellLines` (`sellOrderCreate.ts:24-80`, which also ends its N+1 loop)
  - `sellableInventory.ts:63-95`
  - `inventory.ts` PATCH guard :1214, which moves from EXISTS to a sum: qty edits that stay ≥ committed are allowed, status edits are still refused while anything is committed
  - transfer :1482, reopen :1738, discard :1809
  - `sellOrders.ts:277-299` maxQty
  - `orderAdvance.ts:141-160` and :322-337
  - `orders.ts:2032-2039`
  - hidePending :107 (open statuses including Draft, deliberately)
  - the discard peer merge :1851 keeps "any status", with a comment saying why
- Test: a line with 30 of 100 committed reads as 70 free in the picker, maxQty, the transfer refusal and the inventory PATCH guard.

**M13 — PO PATCH qty vs committed.** `orders.ts:2125-2151`.
- A new qty below `committedQtyByLine` → 409 naming the SO (`committedLinesBody`).
- For partly sold lines, PO PATCH and inventory PATCH move `qty_purchased` by the same delta.
- Tests for both.

**M14 — lock order.**
- (1) Order locks that never delete become `FOR NO KEY UPDATE`: `orders.ts:1785`, `:2522`, `:2627`, `:2923`, and `orderAdvance.ts:426`. Inserting a line (a transfer split, `inventory.ts:1556`) takes a KEY SHARE lock on its parent order, and that no longer conflicts with these, which removes the transfer ⇄ PO PATCH deadlock. DELETE paths keep `FOR UPDATE`.
- (2) New `lockOrdersForLinesTx(tx, lineIds)`: sorted, `FOR NO KEY UPDATE`. It's called **first** in every transaction that locks lines and then writes `orders`: the inventory PATCH (`inventory.ts:1196`) and sell-order Done consumption (`sellOrders.ts:1423-1463`). `goodsTotalIsMirror` and `lineSum` then run under that lock, so the separate SELECT is already safe.
- (3) New manager action `POST /api/orders/:id/total-cost/follow-lines`, with an audited `total_cost_reset` event, allowed at any stage because it's a correction. The PO cost card shows "Negotiated lot price" with a manager "Follow line total" button (desktop and phone).
- Guarded data migration for PO-1339 only (`id='PO-1339' AND total_cost=8500`). The other 11 pinned POs are listed in the PR for your review.
- Concurrency tests: transfer + PO PATCH, inventory PATCH + PO PATCH, and sell-order Done + PO PATCH. Each must have no 40P01 and a correct total.

**Draft-named full transfer.** A full move of a line only a Draft names → 409 `{needsConfirm, drafts}` unless `confirmDrafts: true`. The modal confirms, naming the drafts.

**Transfer modal cap.** The manager inventory list (`inventory.ts:186-200`) adds `committedQty` via the M40 fragment. The modal's max is `qty - committedQty`, with a hint.

## Batch 6a — validation (behaviour) → patch bump
- **M12:** new `lib/orderInput.ts` `validateLineInput(l, mode)`. Rules:
  - `qty`: integer > 0, required on create;
  - `unitCost`: finite and ≥ 0, required on create;
  - `sellPrice`: null, 0 or finite > 0 (0 = "unprice", `inventory.ts:1250`);
  - `health`: 0–100;
  - `rpm`: integer > 0;
  - string types and lengths.
  
  It's used by POST `/` (`orders.ts:1147-1270`), PATCH `lines`/`addLines` (replacing the `badLine` closure at :1628), and the inventory PATCH (:1140; adds rpm). A blank qty in the drawer goes out as 0 (`editLine.ts:52`) and now gets a translated 400 message.
  - Migrations: `CHECK (unit_cost >= 0)` (prod: 0 violations), and `CHECK (total_cost IS NULL OR total_cost >= 0)` after a prod check for negatives.
- **M15:** the inventory sentinel pattern (`CASE WHEN has(f) THEN specVal(v) ELSE col END`) applies **only to the fields the line editors manage**: brand, capacity, generation, type, classification, rank, speed, interface, form_factor, description, item_type, health, rpm and chip.
  - `scanImageId` and `scanConfidence` **keep COALESCE**, because `orderLineToEditLine` (`submit/editLine.ts:9-41`) never copies `scanConfidence` and `editLineToPatch` sends `?? null` (:68-71). Fix that comment.
  - The synthetic part-number rebuild (`orders.ts:2100-2111`) switches from `l.x ?? stored.x` to `has()`.
  - `changesMaterialField` compares the normalised value that will land.
  - The phone path to audit is `MobileApp.tsx:466-468` (`toAddLine` minus status, every field `?? null`); `OrderDetail.tsx` sends no lines.
  - Tests: a full-echo save from each editor's payload builder changes nothing and does not revert; clearing a field is a real material change.

## Batch 6b — `orders.ts` split (structure only, no behaviour change) → patch bump
- **M38:** split the 3541-line `routes/orders.ts` into `routes/orders/`:
  - `index.ts` (router)
  - `list.ts`, `detail.ts`, `create.ts`, `patch.ts`
  - `lifecycle.ts` (advance, handoff, archive, delete, revert-ack, pull)
  - `evidence.ts` (status-meta, photos), `checks.ts` (Review mode), `spreadsheet.ts`
  - `shared.ts` (the helpers at :64-300, :1333-1491)
- The PATCH transaction moves to `services/orderPatch.ts`.
- A typed `OrderRefusal` (a discriminated `kind` plus payload, like `HandoffRefused`) replaces the 14 `__SENTINEL__` strings in PATCH, attachments, photos and `webSubmissions.ts`, with one `refusalResponse()` mapper.
- Every existing orders test passes unchanged.
- **Peer coordination:** run it when `gh pr list` shows no open PR touching `orders.ts`, merge quickly, and note in the PR that other sessions should rebase.

## Batch 7 — money and reporting → minor bump (sequential: it also edits `sellOrders.ts`)
- **M24:** migration `sell_orders.done_at`.
  - Backfill Done rows from `COALESCE(latest status_changed→Done event, status_meta Done set_at, updated_at)`. Event detail is `{from,to}` (`sellOrders.ts:1397`).
  - Set it in the single status write (:1364). Done is terminal (`:1124`), so there's no clear-on-reopen path.
  - `dashboard.ts:54-55,174` and `contributions.ts:77` use it. Index on `(status, done_at)`.
- **M25:** `COALESCE(ol.qty_purchased, ol.qty)` at `dashboard.ts` :114-123, :145, :205, :252, :291, `contributions.ts:130` and `suppliers.ts:487`.
- **M26:** export `paidUnitCost` (`po-cost.ts:69`) and use it for the manager realized cost and profit (`dashboard.ts` :100, :134, :175, :279, `contributions.ts:84`). Commission stays on `eff`.
- **M27:** `customers.ts:45-67` — revenue counts Done only (archived Done included); outstanding counts Shipped and Awaiting payment.
- **M28:** migration adds an `IMMUTABLE` SQL function `supplier_name_key(text)` (compressed alnum; `'U:'||lower(btrim(name))` when that's empty).
  - `match_key` gets a DROP + ADD GENERATED rebuild (`SET EXPRESSION` is PG17+; local is 16).
  - Recreate **exactly** `suppliers_owner_match_idx (owner_id, match_key) NULLS NOT DISTINCT`, which `webSubmissions.ts:224` `ON CONFLICT` infers, and `suppliers_match_key_idx`.
  - Rekey or delete dismissal rows whose key is `''`.
  - `suppliers.ts` `COMPRESS`, the adopt package match (:364-372) and the suggestions (:286-292, :311, :325) all call the function. Suggestions stay name-only, because package seller names have no zip. The create-409 lookup (:441-448) uses it instead of the JS copy.
- **Supplier rollups (RS-107 follow-up):** non-manager spend, po_count, gap and items are scoped to their own POs (`suppliers.ts:115-155`). The tier rank stays company-wide.
- **M20:** `/unpair` (`bankTx.ts:594-604`) keeps the link on the PayPal leg and clears link, assignee and internal on the other. A guarded data migration fixes the one prod case.
- **M21/M22:** `sync.ts:442-575`.
  - Load the last 120 days plus pending only.
  - Bucket per ±`PAIR_WINDOW` around each leg (as `match.ts` `pairCandidatesBatch` does).
  - The amount-only branch needs a PayPal marker on the Mercury leg; transferPair needs the PayPal ACH descriptor.
- **M23:** migration `bank_transactions.currency TEXT NOT NULL DEFAULT 'USD'`, backfilled from `raw`.
  - `NormalizedTxn.currency` (`paypal.ts:337`).
  - The reconciliation fragments require USD.
  - The feed shows a "not reconciled ({CUR})" badge.
- Tests:
  - a sale edited later stays in its Done month;
  - a partial sale doesn't shrink commission;
  - a lot-priced cost;
  - customer tiles;
  - CJK suppliers (create, adopt, suggest);
  - unpair keeps one link;
  - a stale same-amount leg doesn't block a pair;
  - a card charge doesn't amount-pair;
  - a EUR row is excluded.

## Batch 8 — frontend robustness, lists and cursors, PO rules → minor bump
**Backend first (paths as they are after 6b):**
- **M18:** `lib/pagination.ts` gains `cursorTsSelect(expr)` (`to_char(… 'US')`) and `cursorTsParam(ts)` (`(${ts}::text)::timestamptz`), plus a µs format check. The template is `inventory.ts:47,725,738`. Apply to `activity.ts`, `bankTx.ts`, `internalTx.ts`, the orders list (now `routes/orders/list.ts`), `sellOrders.ts` and `webSubmissions.ts`, with one µs-burst paging test per route.
- New `GET /api/sell-orders/stats` for the tiles.

**Frontend:**
- **M37:**
  - `DesktopSellOrders.tsx` tiles come from `/stats`; the list uses `forEachKeysetPage`.
  - The phone `Orders.tsx:62` and `DesktopInternalTxns.tsx:76` use `forEachKeysetPage`.
  - The phone `Market.tsx:29` gets offset "Load more".
  - The `DesktopSubmit.tsx:247` draft probe adds `mine=true`.
- **M34:** `DesktopApp.tsx:88-112` clears `loadingOrderId` in the `!m` branch and in cleanup.
- **M35:** new `lib/useUnsavedGuard.ts` (`beforeunload`, `confirmDiscard()` through `ConfirmDialog`, a registry the shell can read), wired into:
  - `DesktopEditOrder.tsx:437` Escape and Cancel
  - `SellOrderDetail` Back (`DesktopSellOrders.tsx:752`)
  - `DesktopSubmit` and `SubmitForm`
  
  `Modal.tsx:46` closes only when mousedown and click both land on the backdrop.
- **M36:** `App.tsx:20-37` picks the shell once per load. When the width crosses 720px, a "Switch to {phone|desktop} layout" button appears; it checks the unsaved registry before swapping.
- **M30:** `lib/api.ts:58-88` runs refresh inside `navigator.locks.request('erp-refresh')`. If another tab refreshed after this request began (a `localStorage` marker, try/catch), it retries without refreshing. Unit test with mocked locks.
- **M39:**
  - New pure `lib/poPermissions.ts` `derivePoPermissions({role, userId, order})`.
  - `packages/shared` exports `MATERIAL_PATCH_KEYS: readonly (keyof OrderPatchBody)[]`. The backend `materialEdit` (now `services/orderPatch.ts`) and both shells compute "material" from the **built payload's keys**, not from dirty flags. That makes drift a type error and removes the phone's extra `commission` (`OrderDetail.tsx:376`).
  - Unit tests.

## Migrations, in order (numbers fixed at implementation; head is 0146)
| Batch | Migration |
|---|---|
| 3b | `login_attempts`: success drops NOT NULL, plus the `(ip, attempted_at)` index |
| 5 | PO-1339 total reset (guarded) |
| 6a | `CHECK unit_cost ≥ 0`; `CHECK total_cost ≥ 0` (after the prod check) |
| 7 | `sell_orders.done_at` + backfill + index |
| 7 | `supplier_name_key()` + `match_key` rebuild + indexes + dismissal rekey |
| 7 | unpair data fix (guarded) |
| 7 | `bank_transactions.currency` + backfill |

## Ops track (each step needs your explicit go-ahead)
| When | Step |
|---|---|
| Phase 0, then after each batch | prod release (dev→main) |
| After 3a/3b are in prod | remove the site origins from prod `CORS_ALLOWED_ORIGINS` |
| Batch 4 | Railway draining window; check there's no dashboard start command; create `prod_reader` and repoint the dev sync |
| Any time | the `docs/backups-cloud-runbook.md` steps |

## Order and dependencies
- **Phase 0 → 3a → 3b → 4 → 5 → 6a → 6b → 7 → 8**, all sequential.
- 3a ships the real client IP before 3b keys limits on it.
- Stock and validation fixes land before the split, with tests, so the split is pure motion.
- 7 and 5 both edit `sellOrders.ts`.
- 8's cursor fix precedes the frontend walking every page.
- Roughly one session per batch.

## Closed or deliberately not doing
- M17: the portal was removed.
- PO PATCH per-line UPDATE batching and packages pagination: decided against in RS-134.
- The supplier tier rank stays company-wide.
- CAPTCHA, the connector approval gate, scrubbing password hashes, and auto layout switching: declined in your decisions.

## Verification
- **Per batch:** the targeted tests above; then `pnpm typecheck`, `pnpm build`, the full suites and green CI (PG18) with migrations also run on local PG16; then the `verify` skill on a scratch-DB stack for anything visible; then dev health after the merge.
- **3a:** service-worker-controlled page loads on `inventory-dev` with the console checked for CSP reports; `curl -I` on `/`, `/assets/*` and a deep link; check that requests carry `X-Client-IP`.
- **3b:** site preflights against dev; after deploy, prod `login_attempts.ip` shows real client addresses.
- **Overall:** when Batch 8 merges, a short re-review (`/code-review high`) over `v1.194.0..HEAD`, and a final table mapping each M-number to its version.

## Step 1 after approval
Commit this plan as `docs/superpowers/plans/2026-10-02-code-review-remaining-work.md` (docs-only PR, no bump), then start Batch 3a in a fresh worktree with a PID lock. Phase 0 and every ops-track row wait for your separate go-ahead.

Review changes: one Plan reviewer found 4 blockers, 9 should-fix and 6 nits. All were applied, and a follow-up prod check made one of them more urgent. Blockers fixed:
- M3: `success` is NOT NULL, the counts are adjusted, and refused reservations are cleaned up.
- M15: sentinel limited to editor-managed fields, scan fields kept, the phone path corrected.
- M14: `FOR NO KEY UPDATE` plus orders-first locking, which removes the transfer deadlock.
- M28: rebuilt with DROP+ADD on PG16, a shared `supplier_name_key()`, and dismissals kept name-only.

Also applied:
- **M9:** `_headers` carries the set, report-only first, and every CSP change bumps index.html.
- **Real client IP (prod-confirmed):** the per-IP limits now key on the Worker's `X-Client-IP`.
- **Smaller fixes:** `sellPrice` allows 0; no done_at reopen path; `oauth_pending_consent` added to the scrub, with a CI test; Railway start command check and `closeAllConnections()`; no archived filter in M40; Batch 3 split into 3a/3b; the shared material-keys design; exact CORS paths; the migration table; strictly sequential batches.

Nothing was rejected.
