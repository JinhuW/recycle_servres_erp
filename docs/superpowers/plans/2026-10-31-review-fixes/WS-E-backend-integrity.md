# WS-E — ERP backend integrity: fix plan

Planned against `origin/dev` f0c1d856 (v1.396.0). Planning only; nothing here
was changed or run live.

## 1. Goal and scope

Fix the ERP backend correctness findings: whether sessions stay valid after a
credential change, PO/SO/inventory/transfer rules and lock order, FX and
finance figures, input validation, migrations/seed, the backend test harness,
and the `packages/shared` + proxy contract surface. Every ticket versions
under the **ERP root `package.json`** (patch bump per PR, plus a
`CHANGELOG.md` section; `docs/FEATURES.md` where noted). **No ticket touches a
tracker deploy, a worker container or a Facebook session**, so none causes a
login. Migrations ship through the normal backend boot (`scripts/migrate.mjs`).
Each one takes the next free number at merge time (head today is `0220`), and
the version is picked just before merge (concurrent sessions collide).

Findings covered (55): A1-01…A1-06, A2-01…A2-16, A2t-01…A2t-12, A3-01…A3-12,
A5-02…A5-05, A8-02…A8-06.

Every cited line was re-read on f0c1d856. All findings still hold except
A2-09 and A5-03, which duplicate WS-I C2-05 (see §4).

## 2. Tickets

Summary (details below):

| Ticket | Title | Findings | Sev | Effort | Migration | Owner gates |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | One credential-version check under one lock order for refresh rotation | A1-01, A1-02 | P2 | L | yes | — |
| E2 | Inventory editor obeys the PO cascade's status rules | A2-01, A2-15 | P2 | M | — | G1 |
| E3 | FX override bounds and one "latest rate" rule | A3-01, A3-11, A2-08 | P2 | M | yes | G2, G3 |
| E4 | Serialise `resetDb` | A2t-01 | P2 | S | — | — |
| E5 | Transfer integrity: delete, reopen, discard, lock order | A2-02, A2-04, A2-05 | P3 | M | — | — |
| E6 | PO lifecycle races and money rounding | A2-03, A2-11, A2-12, A2-13, A2-14 | P3 | L | — | — |
| E7 | Sell-order price bounds, CNY precision, duplicate-lot diff | A2-07, A2-10, A3-10 | P3 | M | yes (A3-10) | G4 |
| E8 | Boundary validation: MCP, workspace, master data, market | A1-04, A1-05, A2-06, A3-07, A3-08 | P3 | M | — | — |
| E9 | Reporting excludes archived POs; dashboard fan-out; bank match | A3-02, A3-03, A3-04, A3-09 | P3 | M | — | G5 |
| E10 | Bank/internal-tx writes from locked reads | A3-05, A3-06, A3-12 | P3 | M | — | — |
| E11 | Retention sweep and graceful loop shutdown | A1-03, A1-06 | P3 | M | — | G6 |
| E12 | Migration ledger, seed re-run, validate 0178 | A5-02, A5-04, A5-05 | P3 | M | yes (A5-05) | G7 |
| E13 | Proxy allowlist and shared contract types | A8-02, A8-03, A8-04, A8-05, A8-06 | P3 | M | — | G8 |
| E14 | Backend test assertions that can actually fail, plus packing out of routes | A2t-02…A2t-12, A2-16 | P3 | L | — | — |

---

### E1 — One credential-version check under one lock order for refresh rotation

- **Closes:** A1-01 (P2, CONFIRMED), A1-02 (P3). This is the architecture item
  *Centralize session and credential validity*.
- **Versions under:** ERP, patch bump. No worker restart.
- **Change:**
  1. **Migration `NNNN_refresh_credential_version.sql`.** Add
     `credential_version INT` to `refresh_tokens` and `oauth_refresh_tokens`.
     Backfill live rows (`revoked_at IS NULL AND expires_at > NOW()`) from
     `users.credential_version`, so no current session is logged out by the
     deploy. Leave the column nullable: service-client OAuth rows have no user,
     and a NULL on a user row means "minted before stamping".
  2. **`src/auth.ts` `issueRefresh`** takes a `credentialVersion` and writes
     it. Callers: login (`routes/auth.ts`) reads it from the user row it
     already loads (`routes/auth.ts:62-68`), and rotation passes the
     locked user's value.
  3. **`src/auth.ts` `rotateRefresh` (200-221).** Use the code-redemption
     order (`oauth/server.ts:571-583`):
     - (a) `SELECT active, credential_version FROM users WHERE id = (SELECT user_id FROM refresh_tokens WHERE token_hash = …) FOR SHARE`;
     - (b) `SELECT … FROM refresh_tokens WHERE token_hash = … FOR UPDATE`;
     - (c) when `rt.credential_version IS NOT NULL AND rt.credential_version <> u.credential_version`, revoke the family and return `{ok:false}`;
     - (d) stamp the successor with `u.credential_version`.

     `FOR SHARE` conflicts with the `FOR NO KEY UPDATE` that the credential
     change's `UPDATE users` takes, so the two queue instead of deadlocking
     (this fixes A1-02). The cv check closes A1-01 even if a row is missed.
  4. **`src/oauth/tokens.ts` `rotateRefreshToken` (176-221)** gets the same
     order and check. Keep the client-id check first. Rows with
     `user_id IS NULL` skip the user lock. `issueRefreshToken` takes and
     stores `credentialVersion`. The code-redemption path passes
     `u.credential_version`.
  5. **`src/routes/me.ts` password change (186-204).** The caller's own family
     survives by design, so inside the transaction, after the cv bump,
     restamp that family's live row:
     `UPDATE refresh_tokens SET credential_version = <new cv> WHERE family_id = ${currentFamilyId} AND revoked_at IS NULL`.
     Without this, the caller's next refresh fails the new check.
  6. **`src/services/members.ts`.** `updateMember` already locks the user row
     `FOR UPDATE` first (160). In `deactivateMember` (218-233), the
     `UPDATE users` is the first statement and takes the lock. No change
     needed beyond a comment on why the order matters.
  7. Update `apps/backend/AGENTS.md` *Auth & CSRF*: rotation locks the user
     row `FOR SHARE` before the token, and the family carries the cv.
     Update `docs/DATABASE.md` with the two columns.
- **Tests:** a new `tests/refresh-credential-race.test.ts`, ported from
  `docs/review-2026-10-31/repro/A1/refresh-vs-reset-race.test.ts` with the
  assertions flipped:
  - after `POST /api/me/password`, the other family's rotated `rt` refresh returns 401 and `GET /api/me` with its `at` returns 401;
  - the OAuth family's rotated refresh token returns `invalid_grant`;
  - the A1-02 BEFORE INSERT-delay variant: both requests are non-5xx;
  - deactivate → reactivate → the old rotated `rt` is refused;
  - the caller's own family still refreshes once after its own password change (guards step 5).

  Extend `tests/oauth-tokens.test.ts`: a service-client (no user) rotation
  still works.
- **Owner gates:** none beyond the normal dev→main release.
- **Rollout and verification:** PR to `dev`. Railway dev boots and migrates;
  confirm `/api/health` shows the version. On dev, sign in on two browsers,
  change the password on one, and confirm the other is logged out at its next
  refresh. Read-only check:
  `SELECT count(*) FROM refresh_tokens WHERE revoked_at IS NULL AND credential_version IS NULL`
  (expect 0 after backfill, apart from rows created during the deploy
  window). **Rollback:** revert the PR. The added column is harmless to old
  code.
- **Effort:** L.

### E2 — Inventory editor obeys the PO cascade's status rules

- **Closes:** A2-01 (P2, CONFIRMED), A2-15 (P3, same handler file).
- **Versions under:** ERP, patch bump. Add a `docs/FEATURES.md` note on the
  inventory editor's refusals.
- **Change:**
  1. Extract the line-status rules from `cascadeBlockers`
     (`services/orderAdvance.ts:191-216`) into a helper both callers use, in
     `services/lineStatusRules.ts`. It takes `(tx, lineIds, newStatus)` and
     returns the committed-claim blockers and the transfer-claimed blockers.
     The PO cascade keeps its order-level wrapper.
  2. In the `routes/inventory.ts` PATCH transaction (around 1455-1467), after
     the line lock:
     - refuse `before.status = 'Sold'` → anything else with 409 `{kind:'sold'}`, unless G1 says manual correction is supported (then require `confirmLeaveSold: true` and write an `inventory_event`);
     - refuse any status change on a line whose `transfer_order_id` names a `transfer_orders` row in `Pending` (409 `{kind:'transferPending'}`);
     - when the new status is not sellable, also count open Draft/packing claims (`committedClaimsByLine` with draft statuses), and return 409 with the SO ids unless `confirmDrafts: true`, mirroring transfer create.

     Map the result through the handler's existing refusal response.
  3. A2-15: in the purchaser branch of `GET /api/inventory/:id`
     (`inventory.ts:1300-1306`), `delete r.transfer_order_id`.
  4. Frontend: the inventory edit dialog (`apps/frontend`) shows the new 409
     messages. That is a copy-only change in the same PR; tell WS-F.
- **Tests:** in `tests/inventory.test.ts`, port
  `docs/review-2026-10-31/repro/A2-verify/a2-verify.test.ts` cases A2-01a/b:
  - sell a lot to Done, then `PATCH {status:'Done'}` → 409;
  - an In Transit line under a Pending transfer, `PATCH` → 409;
  - a line on a Draft SO, `PATCH {status:'Reviewing'}` → 409 listing the SO, 200 with `confirmDrafts`;
  - purchaser GET has no `transfer_order_id`.

  Add the new pair to `tests/stock-lock-order.test.ts`: the inventory PATCH
  against a sell-order save.
- **Owner gates:** **G1.** Is a manual Sold→Done (or Sold→other) change in the
  inventory editor a supported correction? If no, it is a hard 409. If yes,
  it needs an explicit confirm and leaves an audit event.
- **Rollout and verification:** PR to `dev`. On dev, repeat the repro steps
  in the UI and expect the refusal. **Rollback:** revert.
- **Effort:** M.

### E3 — FX override bounds and one "latest rate" rule

- **Closes:** A3-01 (P2, CONFIRMED), A3-11 (P3), A2-08 (P3).
- **Versions under:** ERP, patch bump. Add a `docs/FEATURES.md` note on the
  FX override limits.
- **Change:**
  1. Move `MAX_RATE = 100` from `routes/accounting.ts:66` to `lib/fx.ts`, as
     the exported `FX_MAX_RATE`. Use it in `accounting.ts:619` and in
     `routes/fxRates.ts:65`: require `0 < rate <= FX_MAX_RATE`, and add a
     floor of `1e-4`.
  2. If G2 says yes: compare the rate against the latest `frankfurter` row.
     Outside ±20%, answer 409 `{kind:'outOfBand', latest}`, and accept it
     only with `confirm: true`. Show the confirm in the frontend FX dialog
     (tell WS-F).
  3. **Migration `NNNN_fx_rates_bounds.sql`:**
     `ALTER TABLE fx_rates ADD CONSTRAINT fx_rates_rate_bounds CHECK (rate > 0 AND rate <= 100) NOT VALID;`
     then `VALIDATE CONSTRAINT` in the same file. Ship it only after G3: a
     violating row would fail boot.
  4. A3-11: `getLatestRateToUsd` (`lib/fx.ts:76-84`) orders by
     `effective_date DESC, fetched_at DESC`, the same as `cnyPerUsdOnFrag`.
  5. A2-08: in `routes/afterSales.ts:124-130`, when `cnyPerUsdOnFrag` is NULL
     (empty ledger), stop the case vanishing into `SUM` as NULL→0:
     - count such rows into `unconvertedCount` per status;
     - return it in the response, and show "n RMB cases not converted" in the summary UI (tell WS-F);
     - document in a comment that after-sales (case-day rate) and accounting
       (booking-day rate) intentionally differ by date but now share one
       selection rule.
- **Tests:**
  - `tests/fx-routes.test.ts`, ported from `docs/review-2026-10-31/repro/A3-verify/a3-01-fx-override.test.ts` and `repro/A3/a3-repro.test.ts`: POST 7100 → 400 and no row stored; POST 1e-9 → 400; a valid override → 201 and is used by a USD accounting entry with no `fxRate`; out-of-band → 409, then 201 with confirm (if G2).
  - A new `tests/fx-latest.test.ts`: a manual row for today plus a frankfurter row for yesterday fetched later; both readers return the same rate.
  - `tests/after-sales.test.ts`: an RMB case with empty `fx_rates` reports `unconvertedCount: 1`.
- **Owner gates:**
  - **G2.** Besides the hard 0–100 cap, should an override more than ±20% from
    the latest market rate need an explicit confirm? (yes/no)
  - **G3.** Before the release reaches `main`, run read-only on prod:
    `SELECT min(rate), max(rate) FROM fx_rates;`. If any row is ≤ 0 or > 100,
    correct it, or drop the VALIDATE from the migration.
- **Rollout and verification:** PR to `dev`. Dev boots and migrates. On dev,
  check `SELECT convalidated FROM pg_constraint WHERE conname='fx_rates_rate_bounds'`,
  and that a 7100 override is refused. **Rollback:** revert. If needed,
  `DROP CONSTRAINT` in a follow-up migration.
- **Effort:** M.

### E4 — Serialise `resetDb`

- **Closes:** A2t-01 (P2, CONFIRMED).
- **Versions under:** ERP (test files under `apps/` trip `version-check`), patch bump.
- **Change:** in `apps/backend/tests/helpers/db.ts:134-155`:
  - chain resets on a module-level promise (`let resetting = Promise.resolve()`; `resetDb = () => (resetting = resetting.catch(() => {}).then(doReset))`);
  - run `DROP DATABASE IF EXISTS … WITH (FORCE)` immediately before `CREATE DATABASE … TEMPLATE`, so a clone left behind cannot block the next reset;
  - give `doReset` an `AbortSignal` time box shorter than `hookTimeout`, so an abandoned reset cannot outlive its test.

  Record the rule in `apps/backend/AGENTS.md` *Tests*.
- **Tests:** move `docs/review-2026-10-31/repro/A2t/reset-cascade.repro.test.ts`
  to `apps/backend/tests/reset-db-serial.test.ts`. It fails 3/3 today and
  must pass after the fix. Then run the whole suite at `VITEST_MAX_FORKS=8`
  twice.
- **Owner gates:** none.
- **Rollout and verification:** the CI `backend-tests` job stays green.
  Nothing deploys. **Rollback:** revert.
- **Effort:** S.

### E5 — Transfer integrity: delete, reopen, discard, lock order

- **Closes:** A2-02, A2-04, A2-05 (P3).
- **Versions under:** ERP, patch bump.
- **Change:**
  1. A2-02, `routes/warehouses.ts:331-348`: refuse warehouse DELETE (409
     `{kind:'pendingTransferOrigin', transferIds}`) while a Pending transfer
     has lines whose `transferred` event names this warehouse as origin. This
     is the refuse option, chosen over a NULL fallback in discard, because a
     discard that cannot restore an origin is lost history. Also make discard
     (`inventory.ts:2186-2192`) check that the origin exists and answer 409
     rather than an FK 500, for rows already in that state.
  2. A2-04: add `ORDER BY l.id` to the four locking SELECTs (`inventory.ts`
     1999-2004, 2083-2088, 2155-2160, 2198-2203). Lock clones and their peers
     in one sorted statement.
  3. A2-05: give reopen (2098-2100) the same proposal/`confirmDrafts` check
     transfer create uses. Discard (2166-2168, 2231) refuses with 409 when an
     open SO (Draft included) names the clone lot.
- **Tests:**
  - in `tests/transfer-orders.test.ts`: create a pending transfer from WH-A, then `DELETE /api/warehouses/WH-A` → 409, and discard on a pre-broken row → 409, never 500 (port A2-02 from `repro/A2-verify/a2-verify.test.ts`); reopen + discard with a Draft SO naming the clone → 409;
  - in `tests/stock-lock-order.test.ts`: receive racing advance.
- **Owner gates:** none.
- **Rollout and verification:** PR to `dev`, and an e2e transfer on dev
  (create, then delete warehouse, expect refusal). **Rollback:** revert.
- **Effort:** M.

### E6 — PO lifecycle races and money rounding

- **Closes:** A2-03, A2-11, A2-12, A2-13, A2-14 (P3).
- **Versions under:** ERP, patch bump.
- **Change:**
  1. **A2-03, archive.** `routes/orders/lifecycle.ts:184-190` and
     `services/orderAdvance.ts:374-440`. `removeFromSellOrders` becomes
     `removeFromSellOrders: { solIds: string[] }`, the set the first 409
     listed. Under the lock, recompute the set. If it differs, return a fresh
     409 with the new set and change nothing. Lock the named SOs (sorted)
     before the line lock, per the one lock order.
     - The frontend archive confirm (`DesktopOrders`/mobile) echoes the ids.
       Keep accepting a bare `true` for one release, treated as "the current
       set", so a stale tab still works.
     - Ship backend and frontend in this PR. WS-F must not edit the archive
       dialog in parallel.
  2. **A2-11.** Round money inputs to 2 dp before comparing
     (`routes/orders/shared.ts:557-566, 648-657`; `routes/orders/patch.ts:462-473, 930-941`).
     Write `reverted` only when a stored value actually changed.
  3. **A2-12.** In `lifecycle.ts:93-98`, before the claim check, lock the
     PO's lines `ORDER BY id FOR UPDATE`, after the order row.
  4. **A2-13.** `orderAdvance.ts:521` and `patch.ts:331-333`: move the
     package subqueries out of the locking SELECT into a second statement run
     after the lock.
  5. **A2-14.** In the `orderAdvance.ts:608-618` `submitted` event, record
     `COALESCE(o.total_cost, SUM(COALESCE(qty_purchased, qty) * unit_cost))`.
- **Tests:**
  - `tests/orders-archive-stock.test.ts`: archive → 409 [SO-1]; add a line to SO-2 and ship it; retry with `{solIds:['SO-1']}` → 409 [SO-1, SO-2], and SO-2 is unchanged (port A2-03 from `repro/A2-verify/a2-verify.test.ts`);
  - `tests/orders.test.ts`: PATCH a Reviewing PO with stored+0.003 → lifecycle stays reviewing and no `reverted` event;
  - `tests/orders-stage-and-claim-races.test.ts`: a two-connection draft delete racing an SO claim → 409 or clean, never a NULL `inventory_id`; a barrier where advance waits on a PATCH that inserts a package, then succeeds;
  - `tests/order-goods-total.test.ts`: submit a pinned-total PO and assert `detail.totalCost`.
- **Owner gates:** none.
- **Rollout and verification:** PR to `dev`, then archive a PO with an open SO
  on dev through the UI. **Rollback:** revert. The bare-`true` compatibility
  keeps old tabs working either way.
- **Effort:** L.

### E7 — Sell-order price bounds, CNY precision, duplicate-lot diff

- **Closes:** A2-07, A2-10, A3-10 (P3).
- **Versions under:** ERP, patch bump.
- **Change:**
  1. **A2-07.** In `routes/sellOrders.ts:599`, cap `unitPrice` at the
     after-sales `MAX_AMOUNT` (1e9). Move that constant to a shared lib and
     reject more than 2 decimals on USD input, so the request gets a 400
     rather than a numeric-overflow 500.
  2. **A2-10.** `services/sellOrderLineMatch.ts:64-75`: first cancel
     identical snapshots as a multiset on `tupleKey`, then pair the remainder
     by fewest changed fields.
  3. **A3-10, if G4 is yes.**
     - Migration `NNNN_sell_line_unit_price_scale.sql` widens
       `sell_order_lines.unit_price` (0002, numeric(…,2)) to `numeric(14,4)`.
       This is a widening ALTER that rewrites the table; size check on prod
       below.
     - `sellOrders.ts:911, 1357` store the converted CNY unit price at 4 dp.
     - The line total and realized revenue round to cents once, at the total.
     - `convertToUsd` (`lib/fx.ts:45-47`) gains a `dp` parameter.
     - Existing rows are untouched.
     - Update `docs/DATABASE.md`.
- **Tests:**
  - `tests/sellOrders.test.ts`: `unitPrice: 1e10` → 400; `0.001` USD → 400;
  - unit test in `tests/sell-order-line-match.test.ts`: `diff([X/2/New, X/3/Used], [X/3/Used])` gives removed `[X/2/New]` and edited `[]`; the swapped order gives an empty diff;
  - a CNY SO with qty 1000 at ¥1.00 has a line total within $0.01 of ¥1000/rate.
- **Owner gates:** **G4.** Should new CNY sell lines store the USD unit price
  at 4 decimals, so realized revenue matches the CNY total? (yes/no)
  Historical lines stay as they are. If no, ship 1 and 2 only, and A3-10
  moves to deferred.
- **Rollout and verification:** PR to `dev`. On dev, check
  `\d sell_order_lines` (read-only) and create a CNY SO. Before the prod
  release, the owner reads `pg_total_relation_size('sell_order_lines')`; it
  is small today, so the rewrite is seconds. **Rollback:** revert the code.
  The widened column is compatible.
- **Effort:** M.

### E8 — Boundary validation: MCP, workspace, master data, market

- **Closes:** A1-04, A1-05, A2-06, A3-07, A3-08 (P3).
- **Versions under:** ERP, patch bump.
- **Change:**
  1. **A1-04.**
     - Add a `ToolError` class in `src/mcp/`.
     - Tools validate numeric and UUID args at entry (`mcp/tools/market.ts:93`, `sellOrders.ts:99,146`) and throw `ToolError` with a clean message.
     - The catch in `mcp/server.ts:145-147` returns `e.message` only for a `ToolError`, and "tool call failed" otherwise. The full error stays in `mcpLog`.
  2. **A1-05.** Add validators in `routes/workspace.ts` `KNOWN_SETTINGS`:
     - the public-form budget keys read by `routes/publicForms.ts:75` (positive integers);
     - `mcp.sellOrderCustomerId` (a UUID of an existing customer, checked in the handler);
     - `getWorkspaceSetting` (`lib/settings.ts:15-19`) falls back when `typeof v !== typeof fallback`, which defuses legacy bad rows.
  3. **A2-06.**
     - Require nonblank trimmed `name`/`label` in the PATCH validators (`routes/customers.ts:115-117`, `categories.ts:98`, `suppliers.ts`).
     - In `suppliers.ts:551-573`, map unique violation 23505 on `match_key` to 409.
     - In `suppliers.ts:607-609`, validate `nextFollowUpAt` as an ISO date and `cadenceDays` as an integer from 1 to 365.
  4. **A3-07.** In `routes/market.ts:58-64`, use `escapeLike(search)` and
     `LIKE … ESCAPE '\'`, as `/parts` does (line 119).
  5. **A3-08.** In `market.ts:455`, require `price > 0` and the importer's
     ceiling (`market.ts:362-365`).
- **Tests:**
  - `tests/mcp-server.test.ts`: `list_market_values` with `limit` `'x'` and `-5`, and `create_sell_order_draft` with `inventoryId: 'nope'`, give `isError` and a message with no Postgres text;
  - `tests/workspace.test.ts`: a budget key set to `'abc'` → 400; the intake form still admits with a bad legacy row present;
  - customers/categories/suppliers: `{name:''}` → 400, duplicate rename → 409, bad date → 400;
  - `tests/market-pagination.test.ts`: `q='_'` returns only labels or PNs that contain an underscore;
  - `tests/market-manual-price.test.ts`: price 0 → 400.
- **Owner gates:** none.
- **Rollout and verification:** PR to `dev`. Run a read-only check on prod
  before release: `SELECT key, value FROM workspace_settings` for the budget
  and MCP keys, to see whether any legacy value would now fall back. The
  fallback is the fix, so this needs no gate. **Rollback:** revert.
- **Effort:** M.

### E9 — Reporting excludes archived POs; dashboard fan-out; bank match

- **Closes:** A3-02 (P3, CONFIRMED), A3-03, A3-04, A3-09 (P3).
- **Versions under:** ERP, patch bump. Add a `docs/FEATURES.md` note on the
  dashboard and leaderboard archive rule.
- **Change:**
  1. **A3-02.** Add one exported fragment, `reviewedLiveFrag(sql)` =
     `lifecycle = ANY(REVIEWED) AND archived_at IS NULL`, in
     `services/contributions.ts`. Use it in:
     - `routes/dashboard.ts` `projDateWin`/`projPrevWin` (59-62);
     - both leaderboard CTEs (268-287);
     - `contributions.ts` `reviewed` (69-70, 132).

     The manager's realized lens stays as it is. G5 decides whether archived
     Done POs are carved out.
  2. **A3-03.** Replace the two `Promise.all` fan-outs
     (`dashboard.ts:112-345`, `contributions.ts:114,154`) and
     `market.ts:76,335` with `allLimited(…, 4)`. Add
     `tests/no-unbounded-fanout.test.ts`, a grep test that fails on
     `Promise.all(` in `src/routes` and `src/services` over sql calls, with an
     explicit allowlist.
  3. **A3-04.** In `banktx/match.ts:438-486`, compute `exact` against both
     goods and goods+fees, report `amountDiff` against the nearer one, and use
     goods+fees for `covered`.
  4. **A3-09.** In `lib/market.ts:150-161`, add `o.archived_at IS NULL AND
     o.lifecycle <> 'draft'`.
- **Tests:**
  - `tests/dashboard-projected.test.ts`, ported from `repro/A3-verify/a3-02-archived-po.test.ts`: an archived reviewed PO adds nothing to the purchaser KPIs, series, contrib cards or leaderboard, and unarchiving restores it;
  - `tests/banktx-match.test.ts`: a goods+fees payment → reason `exact`, confidence `high`, `amountDiff` 0;
  - `tests/market-internal-sales.test.ts`: an archived PO line does not change `avgPrice` or `samples`.
- **Owner gates:** **G5.** Should an archived PO that was already Done keep its
  projected commission on the purchaser's dashboard and leaderboard? (yes →
  exclude only archived non-Done POs; no → exclude every archived PO)
- **Rollout and verification:** PR to `dev`. Compare a purchaser's dashboard
  on dev before and after for a known archived PO. **Rollback:** revert.
- **Effort:** M.

### E10 — Bank/internal-tx writes from locked reads

- **Closes:** A3-05, A3-06, A3-12 (P3).
- **Versions under:** ERP, patch bump.
- **Change:**
  1. **A3-05.** In `routes/bankTx.ts:1090-1131`, wrap `/unassign` and `/note`
     in `sql.begin`, with `lockBankGroupTx` + `groupOf`, as `/assign` does.
  2. **A3-06.**
     - In `bankTx.ts:516-531` (`/link`) and `banktx/sync.ts:685-693` (`linkPaypalTxnToOrder`), lock the target PO/SO `FOR NO KEY UPDATE` inside the transaction and re-check archived/closed/payment on the locked row.
     - Lock order: orders before bank rows, in both paths. Record it in `apps/backend/AGENTS.md` next to the order→lines rule.
  3. **A3-12.** In `routes/internalTx.ts:287-290`, read the record
     `FOR KEY SHARE` inside the transaction, and return 404 when it is gone.
- **Tests:** barrier tests in `tests/banktx-*.test.ts` and
  `tests/internal-tx.test.ts`:
  - hold the group lock, start `/note`, pair the legs, release: both legs carry the note;
  - archive vs `/link`: either the link is refused, or the PO ends unarchived and linked, never archived and linked;
  - delete racing an add-member → 404, not 500.

  Add the archive vs `/link` pair to `tests/stock-lock-order.test.ts`.
- **Owner gates:** none.
- **Rollout and verification:** PR to `dev`, then link and note a bank row on
  dev. **Rollback:** revert.
- **Effort:** M.

### E11 — Retention sweep and graceful loop shutdown

- **Closes:** A1-03, A1-06 (P3).
- **Versions under:** ERP, patch bump.
- **Change:**
  1. **A1-03.** Add `lib/authRetention.ts` with `startAuthRetentionLoop(sql)`,
     registered in `server.ts:36` `loops`. Once a day, one minute after boot,
     it deletes, in batches of 5k:
     - `login_attempts` older than 1 d;
     - `refresh_tokens` and `oauth_refresh_tokens` revoked or expired more than 30 d ago. This keeps reuse detection for a live family: a family's revoked rows go only once its newest row is expired or revoked past the window;
     - consumed or expired `oauth_authorization_codes` and pending consent past their TTL;
     - `public_form_reservations` older than 10 min.

     Delete from the oldest first, in batches. Use E11's stop flag (below).
  2. **A1-06.**
     - Loops return `{ stop(): void; idle(): Promise<void> }`, where `idle` resolves once the current tick has finished.
     - `lib/shutdown.ts:37-44` awaits `Promise.all(loops.map(l => l.idle()))`, raced against `graceMs`, before `closeDb`.
     - `webSubmissionPurge.ts:89-112` gets a `stopped` flag checked between batches.
     - Migrate the other loops in `server.ts` to the same shape. A loop with no tick in flight returns a resolved promise.
- **Tests:**
  - `tests/auth-retention.test.ts`: seed expired, old and live rows; only the expired ones go; the reuse of a recently revoked row in a live family still revokes the family;
  - `tests/shutdown.test.ts`: a loop with a pending tick delays `closeDb` until it settles or `graceMs` passes;
  - purge stops between batches after `stop()`.
- **Owner gates:** **G6.** Approve the retention windows: login attempts 1 day,
  revoked/expired refresh rows 30 days, codes and consent at expiry, and form
  reservations 10 minutes. (yes/no, or other numbers)
- **Rollout and verification:**
  - Before the release, the owner runs read-only on prod: `SELECT count(*)` per table, and the counts the sweep would delete.
  - After deploy, the first run logs `auth retention swept` with its counts. Check the log in Railway dev, then in prod.
  - **Rollback:** revert. Deleted rows are expired by definition.
- **Effort:** M.

### E12 — Migration ledger, seed re-run, validate 0178

- **Closes:** A5-02, A5-04, A5-05 (P3).
- **Versions under:** ERP, patch bump.
- **Change:**
  1. **A5-02 (ERP side).**
     - `scripts/migrate.mjs:136-160`: after the loop, `log.warn('ledger row has no file', { filename })` for every ledger name missing from `files`. Not fatal, since prod must boot.
     - Add `scripts/check-migration-names.sh`: `git diff --name-status origin/main -- apps/backend/migrations` fails on any `D` or `R` entry.
     - Run the script as a step in `.github/workflows/backend-tests.yml`. Tell WS-D, which owns the CI gates.
     - The `deploy/railway-sync/sync.sh` and `keep-fleet.sql` half is in WS-B (see §3): capture only filenames present in the image, and remove the dev ledger's orphan `0216_fleet_cities_drop_pinned.sql` row (an owner action already listed under WS-B / README *Needs owner* #5).
  2. **A5-04.** `scripts/seed.mjs:555-569`: before deleting sell orders and
     orders, run `UPDATE bank_transactions SET order_id=NULL, sell_order_id=NULL, link_kind=NULL, linked_at=NULL WHERE linked_at IS NOT NULL`,
     as 0176's comment prescribes. Run the reset section in one
     `sql.begin`.
  3. **A5-05.** Migration `NNNN_validate_bank_tx_ignored_unlinked.sql`:
     `ALTER TABLE bank_transactions VALIDATE CONSTRAINT bank_transactions_ignored_unlinked_check;`
     It takes a SHARE UPDATE EXCLUSIVE lock and does not block writes.
- **Tests:**
  - `tests/migration-ledger.test.ts`: insert a ledger row for a missing file, run `migrate.mjs`, assert the warning line;
  - `tests/seed-rerun.test.ts`: seed, link a bank row to a sell order, run `seed.mjs` again on the worker DB, assert exit 0;
  - `tests/schema-constraints.test.ts`: every CHECK on `bank_transactions` has `convalidated = true`.

  The CI script is self-testing: run it locally with a staged rename to see it
  fail.
- **Owner gates:** **G7.** Before the release reaches `main`, run read-only on
  prod: `SELECT count(*) FROM bank_transactions WHERE ignored AND (order_id IS NOT NULL OR sell_order_id IS NOT NULL)`
  (the 0178 predicate). 0178's comment says which side was wrong is a manager's call. If it is non-zero, decide how to clear those
  rows; otherwise the VALIDATE fails boot.
- **Rollout and verification:** PR to `dev`. Dev boots and migrates; check
  `pg_constraint.convalidated` on dev. `pnpm db:seed` twice locally.
  **Rollback:** revert. A validated constraint needs no undo.
- **Effort:** M.

### E13 — Proxy allowlist and shared contract types

- **Closes:** A8-02, A8-03, A8-04, A8-05, A8-06 (P3).
- **Versions under:** ERP, patch bump. The tracker side is unchanged, so
  there is no tracker release and no worker restart.
- **Change:** every edit is ERP-side. The tracker endpoints stay, so there is
  no cross-side ordering.
  1. **A8-02, if G8 is yes.** Delete `GET /stats/reviews`
     (`routes/coordinator.ts:227-231`) and `PUT /accounts/:id` (266-292),
     with their tests. No frontend calls them (grep of `apps/frontend/src`).
  2. **A8-03, if G8 is yes.** Delete the POST/PATCH/DELETE `/rules` routes in
     `routes/tracker.ts:89-93`. The UI calls only `GET /api/tracker/rules`
     (`lib/tracker.ts:324`). In the root `AGENTS.md` *Contracts* row, change
     "rules" to "rules (read)". WS-I C2-02 edits the same table, so
     coordinate wording.
  3. **A8-04.** In `packages/shared/src/fleet.ts:665-673`, `directives:
     Array<'relogin' | 'resume'>` and add `resume_id?: string`. In
     `fleet/claim.ts:544-549`, build the payload as
     `const answer = {…} satisfies HeartbeatAnswer`.
  4. **A8-05.** Export one `WORKER_ID_RE` matching the console's
     `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (`rs_console/app.py:267`) from
     `packages/shared/src/fleet.ts`. Use it for `WORKER_ID` (342) and
     `VNC_WORKER_ID` (474) in `coordinator.ts`.
  5. **A8-06.** In `fleet/proxyHealth.ts:32`, set `CONSOLE_TIMEOUT_MS` to
     60 000. This is a server-side round, not behind Cloudflare's 100 s
     edge. Write the reason in the comment: the console dials ports 8 at a
     time with an 8 s cap. A console-side total cap would be WS-G's, and is
     not needed once the ERP waits long enough.
- **Tests:** in `tests/coordinator-routes.test.ts`:
  - `PUT /api/coordinator/accounts/x` → 404 and `GET /stats/reviews` → 404;
  - `GET /api/coordinator/workers/a.b/logins` is forwarded.

  In `tests/tracker-routes.test.ts`: `POST /api/tracker/rules` → 404. In
  `tests/fleet-proxy-health.test.ts`: a fake console that answers after 31 s
  (fake timers) still yields `ok` rows. `pnpm typecheck` enforces A8-04.
- **Owner gates:** **G8.** Is a coordinator account-credential form or a
  Reddit rule editor planned? If no, delete the three unused write paths and
  `stats/reviews`. If yes, keep them and file a ticket for the UI.
- **Rollout and verification:** PR to `dev`. On dev, the Fleet page proxy tab
  shows coordinator rows. Contract tests are green (136/136 baseline).
  **Rollback:** revert.
- **Effort:** M.

### E14 — Backend test assertions that can actually fail, plus packing out of routes

- **Closes:** A2t-02 … A2t-12 (P3), A2-16 (P3, carryover BD-11).
- **Versions under:** ERP, patch bump. It can split into two PRs (tests,
  then the refactor) if review size demands.
- **Change:** test edits only, plus one move.

  | ID | Edit |
  | --- | --- |
  | A2t-02 | `wave2b-fixes.test.ts:245-284`: Fix 3b attaches an open SO before advancing forward; Fix 3c asserts each SO status call is 200, then advances done→reviewing→in_transit and expects 200 |
  | A2t-03 | `order-goods-total.test.ts`: price the line first (379-391); assert PATCH 200 at 112-117, 135, 226, 334 |
  | A2t-04 | Assert setup/subject statuses and every field each title names; use `toBe(before)` for event counts in the 10 cited files |
  | A2t-05 | Add the positive half before each negative assertion in the 7 cited files |
  | A2t-06 | Move `waitBlocked()` to `tests/helpers/`; replace `pause(300)` in `orders-stage-and-claim-races.test.ts:73-112` and `sell-order-edit-guards.test.ts:207-209` |
  | A2t-07 | `toBe(before + n)` in `ref-price-events`, `metrics`, `observability`, `order-serials` |
  | A2t-08 | `expect(rows.length).toBeGreaterThan(0)` before each loop; replace silent returns with `toBeDefined()` in the cited files |
  | A2t-09 | `vi.setSystemTime` for date tests; ReDoS budget relative to a same-test baseline (`input-bounds-redos`, `attachment-image-shrink`, `suppliers`, `semaphore`) |
  | A2t-10 | `part-merge-per-category.test.ts:113-143`: seed the losing spelling and assert it changed |
  | A2t-11 | `sell-order-po-line-no.test.ts`: `not.toBeNull()` and distinctness first |
  | A2t-12 | New `tests/client-timings.test.ts`: 401 with no cookie, 400 with no `loadEvent`, 204 on a valid body, 429 after 20 |
  | A2-16 | Move `keyedLines`/`prunePackRows` from `routes/sellOrderPack.ts:21-43` to `services/sellOrderPack.ts`; update imports in `services/orderAdvance.ts:15` and `routes/sellOrders.ts:49`; add `tests/import-boundary.test.ts`, which fails when a file in `src/services/` imports from `src/routes/` |

- **Tests:** each row's mutation check from the input (for example, inject a
  write before the 409 in the PATCH handler and confirm `orders.test.ts:484`
  fails). Do this locally once per row, and note it in the PR body. Do not
  commit the mutations. The suite must stay green at 8 forks.
- **Owner gates:** none.
- **Rollout and verification:** CI `backend-tests` green. A2-16 changes no
  behaviour (the sell-order-pack and orders-archive tests stay green).
  **Rollback:** revert.
- **Effort:** L.

## 3. Order

1. **E4** first. It is small, and every later ticket's test run depends on a
   reliable harness.
2. **E1, E2, E3**: the P2s. They are independent and can run in parallel.
   E3's prod release waits on G3.
3. **E6**, then **E5**. Both touch `routes/inventory.ts` /
   `services/orderAdvance.ts` locking. Land E6 before E5 to limit rebase
   pain, and run `tests/stock-lock-order.test.ts` after each.
4. **E7, E8, E9, E10, E11, E12, E13** in any order, as capacity allows.
5. **E14** last. The A2-16 move touches `orderAdvance.ts` imports and should
   follow E6. Its test edits touch files E2, E5 and E6 extend, so rebase it
   after them.

Cross-workstream dependencies:

| Ticket | Depends on / coordinates with |
| --- | --- |
| E2, E3, E6 | **WS-F** (frontend copy for the new 409s, the FX confirm, the after-sales unconverted count, the archive confirm echoing SO ids). The backend ships first, compatible with the old UI; E6 lands its frontend change in the same PR, and WS-F avoids that dialog until then. |
| E12 (A5-02) | **WS-B** owns the `deploy/railway-sync/sync.sh` + `keep-fleet.sql` fix and the owner action that removes dev's orphan 0216 ledger row (with A5-01). E12 ships the ERP-side warning and CI check independently. **WS-D**: the new CI step in `backend-tests.yml` should be made a required check under WS-D's gate work. |
| E13 | **WS-I** C2-02 rewrites the AGENTS.md *Contracts* table. Merge wording, not conflicting edits. **WS-G**: no change needed on the console. |
| E1, E3, E7, E12 | **WS-I** C2-05/C2-06 (DATABASE.md). Each migration ticket updates its own DATABASE.md rows in its PR; WS-I's catch-up should rebase over them. |
| all | **WS-D** (CI required before prod deploy). Not blocking, but the migration tickets (E1, E3, E7, E12) are safest once prod waits for CI. |

## 4. Dropped / deferred

| ID | Disposition | Reason |
| --- | --- | --- |
| A2-09 | Dropped (duplicate) | Same defect as WS-I **C2-05**: DATABASE.md misses `after_sales_cases.currency_code` from 0220. Fixed there. |
| A5-03 | Dropped (duplicate) | Same as WS-I **C2-05**, which lists 0209 (`fleet_hosts`) and 0220 (`after_sales_cases`) columns among others. Its "docs check against information_schema" idea goes to WS-I as a suggestion. |

No other finding is deferred. A3-10 becomes deferred only if G4 is answered
"no".

## Owner gates (8)

| Gate | Ticket | Question / action |
| --- | --- | --- |
| G1 | E2 | Is a manual Sold→other status change in the inventory editor a supported correction? (no → hard 409; yes → explicit confirm and an audit event) |
| G2 | E3 | Should an FX override more than ±20% from the latest market rate need an explicit confirm, on top of the 0–100 hard cap? |
| G3 | E3 | Before the prod release, read-only: `SELECT min(rate), max(rate) FROM fx_rates;`. Clear any row outside (0, 100]. |
| G4 | E7 | Store new CNY sell lines' USD unit price at 4 dp (widen `sell_order_lines.unit_price`)? |
| G5 | E9 | Do archived Done POs keep their projected commission on the purchaser dashboard and leaderboard? |
| G6 | E11 | Approve the retention windows: login attempts 1 d, revoked/expired refresh rows 30 d, codes and consent at expiry, form reservations 10 min. |
| G7 | E12 | Before the prod release, read-only: count `bank_transactions` rows violating `bank_transactions_ignored_unlinked_check`. Clear them, or the VALIDATE fails boot. |
| G8 | E13 | Is a coordinator credential form or a Reddit rule editor planned? If not, delete the unused proxy write routes and `stats/reviews`. |

The dev→`main` release of every ticket is the owner's, as always (standing
authorization covers `dev` only).
