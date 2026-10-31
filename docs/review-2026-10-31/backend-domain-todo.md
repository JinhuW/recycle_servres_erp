# Backend domain: PO/SO/inventory and test suite — review 2026-10-31

Lanes: A2 (Backend PO/SO/inventory), A2t (Backend test suite). 28 findings: 0 P1 / 2 P2 / 26 P3. Severity shown is after verification; P3s were not verified.

## P2

- [ ] **A2-01 / P2 / confirmed: Inventory PATCH can move a line out of Sold or off a pending transfer, bypassing the PO cascade's status rules**
  - Location: `apps/backend/src/routes/inventory.ts:1376-1378,1461-1467`
  - Evidence: The only status guard is LINE_STATUSES membership plus 'committed claims > 0' (committedClaimsByLine counts Shipped/Awaiting payment, not Done). The PO cascade refuses the same moves: leaving Sold (orderAdvance.ts:261-263), lines claimed by a Pending transfer (transferClaimedLineIds, orderAdvance.ts:166-169), and lines named by open Draft/Packing sell orders (orderAdvance.ts:205-211).
  - Failure: (a) A lot sold out by a Done SO keeps its qty and is Sold; a manager PATCHes status Sold->Done: no committed claim exists, so the sold units become sellable again and can be sold twice. (b) A line In Transit under a Pending transfer is PATCHed to Done: receive skips it (inventory.ts:~2002) and discard refuses it (inventory.ts:~2168), so the transfer is stuck. (c) Setting a line to Draft leaves Draft/Packing SOs naming it unpromotable.
  - Fix: Share cascadeBlockers' rules with the inventory editor: refuse leaving Sold, refuse status changes on lines whose transfer_order_id is a Pending transfer, and when the new status is not sellable also check open draft/packing claims (or require a confirm).
  - Regression test: Sell a lot out to Done, PATCH /api/inventory/:id {status:'Done'} -> 409; PATCH an In Transit line under a Pending transfer -> 409.
  - Verifier: repro/A2-verify/a2-verify.test.ts 'A2-01a' (passes on 62f53dec, PG18 :55712): PO line qty 4 sold out by SO-1 Done -> status Sold qty 4; manager PATCH /api/inventory/:id {status:'Done'} -> 200 (inventory.ts:1376 accepts Sold->Done; the only status guard, inventory.ts:1461-1467, checks committed claims, which a Done SO no longer holds); SO-2 for the same 4 units then reaches Done: 8 units sold from a 4-unit lot. 'A2-01b': In Transit line PATCHed to Done -> discard 409, but POST /transfer-orders/:id/receive -> 200 and the TO becomes Received. (Part (a) reproduced: a manager can resurrect a sold-out lot and sell it twice (reachable from DesktopInventoryEdit.tsx:823, whose dropdown offers Done/Reviewing). Part (b) is overstated: the transfer is not stuck, receive skips the edited line but closes the TO. Part (c) is by design: inventory.ts:1458-1460 states a line on a mere Draft SO stays editable and is re-validated at promotion. P2 stands on (a) alone: manager-only and deliberate, so not P1.)

- [ ] **A2t-01 / P2 / confirmed: resetDb is not serialised: a reset that outlives its hook timeout races the next test's reset, turning one slow test into a cascade of unrelated failures**
  - Location: `apps/backend/tests/helpers/db.ts:134-155`
  - Evidence: resetDb() runs terminate -> DROP DATABASE -> CREATE DATABASE … TEMPLATE with no per-process mutex (unlike ensureWorkerDb, which shares one `ready` promise, db.ts:66-71). When vitest gives up on a beforeEach after hookTimeout 30 s, the abandoned resetDb keeps running; the next test's beforeEach starts a second resetDb on the same DB name. Baseline 2026-10-31 (baseline/backend-test.log:285-299, 345-346): 16 of the 44 failures are exactly this — 14 x `duplicate key value violates unique constraint "pg_database_datname_index"` and 2 x `database "postgres_87470_mvwu62uq_w8|w1" already exists`, each in the test right after a hook timeout in the same file. The same orphaned work explains the uncaught `TypeError: Cannot read properties of null (reading 'write')` in postgres.js (log, Unhandled Errors, po-sold-lifecycle) and the CONNECTION_CLOSED/ENDED/CONNECT_TIMEOUT "Unhandled error" log lines (log:147, 241): the next reset terminates/ends pools that a timed-out test is still using. Repro: docs/review-2026-10-31/repro/A2t/reset-cascade.repro.test.ts abandons one resetDb() after 5 ms and the following test fails with the identical pg_database_datname_index error, 3/3 runs.
  - Failure: A loaded CI runner or a dev box running two suites (the release gate racing a local run, which global-setup.ts was written for) slows one reset past 30 s; instead of one timeout the file reports a timeout plus N "database already exists"/unhandled-error failures in unrelated tests, and vitest flags "This might cause false positive tests". The 44-failure baseline reads like 20 broken files when none is broken, so real regressions hide in the noise and people learn to rerun until green.
  - Fix: Chain resetDb onto a module-level promise (`let resetting = Promise.resolve(); export function resetDb(){ return resetting = resetting.catch(()=>{}).then(doReset); }`) so a second call waits for the first, and make the CREATE tolerate an existing clone by DROP … WITH (FORCE) immediately before it. Optionally raise hookTimeout or make resetDb time-boxed with AbortSignal so an abandoned reset cannot outlive its test.
  - Regression test: docs/review-2026-10-31/repro/A2t/reset-cascade.repro.test.ts (run with its vitest.repro.config.ts) must pass after the fix; it fails 3/3 today.
  - Verifier: (1) Repro docs/review-2026-10-31/repro/A2t-verify/reset-race.test.ts (+ vitest.config.ts, run.log) against a disposable PG18 on 127.0.0.1:55742 uses the real helpers/db.ts, setup.ts and global-setup.ts. Three overlapping resetDb() calls fail 3/3 runs with 'PostgresError: duplicate key value violates unique constraint "pg_database_datname_index"' (2 of 3 calls rejected each run). (2) The baseline shows the same cascade in the wild, docs/review-2026-10-31/baseline/backend-test.log. At lines 273-346 a 'Hook timed out in 30000ms' in a resetDb beforeEach is followed in the same worker by 'duplicate key ... pg_database_datname_index' and 'database "postgres_87470_mvwu62uq_w8" already exists' in unrelated tests. Line 593 has the same for _w1, line 603 has vitest's 'This might cause false positive tests', and the totals are 20 failed files / 44 failed tests. (3) Code: apps/backend/tests/helpers/db.ts:134-155 resetDb has no in-process mutex or promise chain. Contrast ensureWorkerDb at db.ts:66-71, which memoises exactly because 'a hook that timed out leaves its build running'. The comment at db.ts:132-133 ('runs its tests sequentially, so no cross-process lock is needed') overlooks that vitest does not cancel a timed-out hook's promise. DROP IF EXISTS / CREATE from two overlapping calls race on pg_database. (Reproduced deterministically and visible in the baseline run. The harness turns one slow reset into several unrelated failures, which hides real regressions in the noise. It is test infrastructure only, with no prod impact, so P2 (drift that will bite) is the right rating. Serialising would not make the original slow test pass. The fix is to chain resetDb on a module-level promise (as ensureWorkerDb does), so the next caller waits for the in-flight reset instead of racing it.)

## P3

- [ ] **A2-02 / P3 (raised as P2) / confirmed: Deleting a transfer's source warehouse (no transferTo) makes discard of that transfer fail with an FK 500 forever**
  - Location: `apps/backend/src/routes/warehouses.ts:331-348; apps/backend/src/routes/inventory.ts:2186-2192`
  - Evidence: Delete only blocks on to_warehouse_id; it sets transfer_orders.from_warehouse_id = NULL (transferTo is null). Discard computes origin = ord.from_warehouse_id ?? detail.from, and detail.from in the append-only 'transferred' inventory_event still names the deleted warehouse. Mixed-source transfers (from_warehouse_id NULL) hit it even with transferTo. The delete also rewrites order_lines.warehouse_id without inventory_events.
  - Failure: TO-1 Pending WH-A->WH-B; manager deletes WH-A without transferTo; discard TO-1 runs UPDATE order_lines SET warehouse_id='WH-A' -> FK violation -> 500; TO-1 can never be discarded and its lines stay In Transit.
  - Fix: Refuse warehouse delete while Pending transfers have lines whose transferred events name it, or have discard verify the origin exists and fall back to NULL / transferTo; write a warehouse_reassigned inventory_event per moved line.
  - Regression test: Create pending transfer from WH-A, DELETE /api/warehouses/WH-A, POST discard -> 200 (or 409 on the delete), never 500.
  - Verifier: repro/A2-verify/a2-verify.test.ts 'A2-02': PO in WH-A2V, transfer to WH-DAL (TO Pending, event detail.from='WH-A2V'); DELETE /api/warehouses/WH-A2V (no transferTo) -> 200, nulls transfer_orders.from_warehouse_id (warehouses.ts:349); DELETE /api/inventory/transfer-orders/:id -> 500 (inventory.ts:2192 origin = from_warehouse_id ?? detail.from = deleted id -> FK violation), line stays In Transit; POST .../receive -> 200. (Discard 500s as claimed, but not 'forever': receive still works and lands the goods at the destination, so the transfer and its lines are not stranded. Needs a manager to delete a warehouse with a pending outbound transfer and then choose discard over receive: narrow, with a workaround, so P3.)

- [ ] **A2-03 / P3 (raised as P2) / confirmed: Archive's removeFromSellOrders is a bare boolean; the removal set is recomputed after the manager confirms**
  - Location: `apps/backend/src/routes/orders/lifecycle.ts:184-190; apps/backend/src/services/orderAdvance.ts:374-440`
  - Evidence: The 409 lists the claimed SO lines; the retry sends only removeFromSellOrders:true and archiveOrderLinesTx deletes whatever 'claimed' finds now (openSellStatuses includes committed statuses). Also the SO pre-lock at :374-381 uses an EXISTS subquery evaluated on the statement snapshot, so an SO that gains a claim while the line lock (cascadeBlockers) waits is first locked by the UPDATE sell_orders at :422 — lines before SO header, against the documented order in orderLocks.ts.
  - Failure: Manager A archives PO-1, sees a 409 naming SO-1 (Draft). Manager B adds a PO-1 line to SO-2 and ships it. A confirms: the archive silently deletes the line from Shipped SO-2 and clears its negotiated total, which A never saw. Under the concurrent variant, a save on SO-2 racing the archive can deadlock (40P01 -> 500).
  - Fix: Have the client echo the confirmed sol_id set and return a fresh 409 if claimed differs; lock the SOs named by claimed before the line lock (re-read until stable).
  - Regression test: Archive -> 409 listing SO-1; add line to SO-2 and ship; retry with removeFromSellOrders -> expect 409 listing SO-2, SO-2 unchanged.
  - Verifier: repro/A2-verify/a2-verify.test.ts 'A2-03': manager A archives PO -> 409 naming only SO-1 (Draft); manager B creates SO-2 on the same lot and moves it to Shipped; A re-posts archive {removeFromSellOrders:true} -> 200; SO-2 (still Shipped) now has 0 sell_order_lines. Cause: lifecycle.ts:190 reduces the confirmation to a boolean and orderAdvance.ts:385-400 recomputes the claimed set at confirm time across all open statuses incl. Shipped. (Stale-confirm deletion reproduced exactly as described. The deadlock (40P01) variant was not reproduced and looks guarded: orderAdvance.ts:374-380 takes the sell_orders rows FOR NO KEY UPDATE before the lines, in the documented sell-order-save order. Needs two managers to act on the same PO during one open dialog, so P3 rather than P2. The fix (echo the confirmed solIds and refuse on mismatch) is cheap.)

- [ ] **A2-04 / P3 / P3, not verified: Transfer receive/reopen/discard lock lines with no ORDER BY**
  - Location: `apps/backend/src/routes/inventory.ts:1999-2004,2083-2088,2155-2160,2198-2203`
  - Evidence: FOR UPDATE OF l without ORDER BY, while the PO cascade and delete lock a PO's lines ORDER BY id; discard locks peers after clones.
  - Failure: A transfer holding two lines of one PO is received while that PO advances stage: heap-order vs id-order locking can deadlock (40P01 surfaced as 500).
  - Fix: Add ORDER BY l.id to the locking SELECTs; lock clones and peers together in sorted order.
  - Regression test: Add receive-vs-advance pair to tests/stock-lock-order.test.ts.

- [ ] **A2-05 / P3 / P3, not verified: Reopen + discard of a transfer can delete a clone lot a Draft sell order names**
  - Location: `apps/backend/src/routes/inventory.ts:2098-2100,2166-2168,2201,2231`
  - Evidence: Reopen and discard only count committed claims; discard's sell-order guard is on the peer, not the clone it deletes. sell_order_lines.inventory_id is ON DELETE SET NULL (migration 0127).
  - Failure: Partial transfer creates clone C, received, C added to Draft SO-1, transfer reopened (no committed claim) and discarded: C merges back and is deleted; SO-1's line silently loses its source.
  - Fix: Give reopen the proposal/confirmDrafts check transfer create uses; in discard refuse (or skip merge) when an open SO names the clone.
  - Regression test: The scenario above returns 409 or keeps C referenced.

- [ ] **A2-06 / P3 / P3, not verified: PATCH can blank required names (remaining half of BD-08); supplier PATCH 500s on duplicate match_key and bad nextFollowUpAt/cadenceDays**
  - Location: `apps/backend/src/routes/customers.ts:115-117; apps/backend/src/routes/categories.ts:98; apps/backend/src/routes/suppliers.ts:551-573,607-609`
  - Evidence: COALESCE('', name) stores empty string; suppliers PATCH writes name untrimmed (null -> NOT NULL 500) and has no catch for suppliers_owner_match_idx unlike POST/adopt; nextFollowUpAt/cadenceDays unvalidated.
  - Failure: PATCH customer {name:''} -> 200 blank customer; rename client B to client A's name in same book -> 500 instead of 409; nextFollowUpAt:'x' -> 22007 500.
  - Fix: Require nonblank trimmed name/label in PATCH validators; map unique violation to 409; validate date and integer cadence.
  - Regression test: PATCH {name:''} on each -> 400; duplicate rename -> 409.

- [ ] **A2-07 / P3 / P3, not verified: Sell-order unitPrice has no upper bound or scale check: numeric overflow is a 500**
  - Location: `apps/backend/src/routes/sellOrders.ts:599`
  - Evidence: lineInputError checks only finite and >= 0; unit_price/source_unit_price are NUMERIC(12,2). RMB prices with 3+ decimals are stored rounded while USD is converted from the unrounded value (sellOrders.ts:~911, sellOrderCreate.ts:~191).
  - Failure: POST /api/sell-orders with unitPrice 1e10 -> SQLSTATE 22003 inside the txn -> 500.
  - Fix: Cap unitPrice (like afterSales MAX_AMOUNT) and reject >2 decimals before conversion.
  - Regression test: POST unitPrice:1e10 -> 400.

- [ ] **A2-08 / P3 / P3, not verified: After-sales summary silently drops RMB cases when no USD/CNY rate exists, and uses a different rate than accounting**
  - Location: `apps/backend/src/routes/afterSales.ts:124-130; apps/backend/src/lib/fx.ts:55-62; apps/backend/src/routes/accounting.ts:~1489`
  - Evidence: cnyPerUsdOnFrag returns NULL with empty fx_rates; amount/NULL is NULL and SUM skips it while COUNT(*) counts it. Summary converts at the case-open-day rate, accounting target at the latest rate.
  - Failure: Fresh dev/test DB, one RMB case of 700: tile shows {count:1, amount:0}. In prod the same case shows two different USD figures on the after-sales tiles and the accounting page.
  - Fix: Return an unconverted count (or fall back to latest rate) and pick one conversion rule for both screens.
  - Regression test: Summary with an RMB case and empty fx_rates does not report a silent 0.

- [ ] **A2-09 / P3 / P3, not verified: RS-483 did not update docs/DATABASE.md for after_sales_cases.currency_code**
  - Location: `docs/DATABASE.md:1404-1421; apps/backend/migrations/0220_after_sales_currency.sql`
  - Evidence: The after_sales_cases section has no currency_code row or CHECK and still describes amount as USD; apps/backend/AGENTS.md requires the doc change in the same PR.
  - Failure: A reader of DATABASE.md sums after_sales_cases.amount as USD and mixes RMB refunds into USD totals.
  - Fix: Add currency_code char(3) NOT NULL DEFAULT 'USD', CHECK IN ('USD','CNY'), 'amount is in currency_code'.
  - Regression test: n/a (docs)

- [ ] **A2-10 / P3 / P3, not verified: Duplicate-lot sell-order diff pairs occurrences by position, mislabelling removals as edits (residual of BD-07)**
  - Location: `apps/backend/src/services/sellOrderLineMatch.ts:64-75`
  - Evidence: Within a lot bucket the n-th before occurrence is paired with the n-th after occurrence in position order.
  - Failure: Lot X at pos0 {2,New} and pos1 {3,Used}; manager deletes pos0. Timeline records line_edited X 2->3 New->Used plus line_removed {3,Used} instead of removed {2,New}; a pure reorder writes two phantom line_edited events.
  - Fix: Cancel identical snapshots first (tupleKey multiset), then pair the remainder by fewest changed fields.
  - Regression test: diffSellOrderLines([X/2/New,X/3/Used],[X/3/Used]) -> removed=[X/2/New], edited=[]; swapped order -> empty diff.

- [ ] **A2-11 / P3 / P3, not verified: Sub-cent PO values revert a submitted PO to Draft for an edit that never lands**
  - Location: `apps/backend/src/routes/orders/shared.ts:557-566,648-657; apps/backend/src/routes/orders/patch.ts:462-473,930-941`
  - Evidence: changesMaterialField compares numbers at 1e-9 while columns are NUMERIC(12,2) and validateLineInput does not limit decimals.
  - Failure: Purchaser saves a Reviewing PO with unitCost 33.333 (stored 33.33): PO reverts to Draft, managers notified, stored value unchanged and a 'reverted' event with empty changes is written.
  - Fix: Round money inputs to 2 dp before comparing; only write reverted when something changed.
  - Regression test: PATCH Reviewing PO with stored+0.003 -> lifecycle stays reviewing, no reverted event.

- [ ] **A2-12 / P3 / P3, not verified: Draft PO delete reads sell-order claims without locking the lines**
  - Location: `apps/backend/src/routes/orders/lifecycle.ts:93-98,143; apps/backend/src/services/sellOrderCreate.ts:56`
  - Evidence: Delete checks sell_order_lines unlocked, then deletes the order; SO create locks only the lines.
  - Failure: A Draft PO line hand-set to Done is claimed by a SO committing between the check and the DELETE; cascade sets sell_order_lines.inventory_id NULL, orphaning the SO line.
  - Fix: Lock the PO's lines ORDER BY id FOR UPDATE before the claim check.
  - Regression test: Two-connection interleave -> 409 or clean, never NULL inventory_id.

- [ ] **A2-13 / P3 / P3, not verified: Package subqueries inside locking SELECTs read a pre-wait snapshot**
  - Location: `apps/backend/src/services/orderAdvance.ts:521; apps/backend/src/routes/orders/patch.ts:331-333`
  - Evidence: has_package / pkg subqueries are evaluated with the statement snapshot taken before the FOR NO KEY UPDATE wait (same class as BD-02).
  - Failure: PATCH adding a tracking number commits while /advance enforce:'all' waits on the PO lock: advance wrongly refuses missingTracking.
  - Fix: Read packages in a separate statement after the lock.
  - Regression test: Barrier test: advance waits on PATCH inserting a package, then succeeds.

- [ ] **A2-14 / P3 / P3, not verified: 'submitted' order event records raw line sum, ignoring a negotiated lot price**
  - Location: `apps/backend/src/services/orderAdvance.ts:608-618`
  - Evidence: Computes SUM(qty*unit_cost) rather than the goods total syncOrderGoodsTotal maintains (pinned orders.total_cost, qty_purchased).
  - Failure: PO with agreed $8,500 lot price over lines summing $9,000 shows 'submitted at $9,000' in the audit timeline.
  - Fix: Record COALESCE(o.total_cost, SUM(COALESCE(qty_purchased,qty)*unit_cost)).
  - Regression test: Submit a pinned-total PO and assert detail.totalCost.

- [ ] **A2-15 / P3 / P3, not verified: GET /api/inventory/:id leaks transfer_order_id to purchasers**
  - Location: `apps/backend/src/routes/inventory.ts:1268-1269,1301-1306`
  - Evidence: Selects l.* and the purchaser branch strips only cost fields, while event reads strip transfer ids because transfer orders are manager-only (:42-48).
  - Failure: A purchaser GETs a transferred line of their own PO and sees the manager-only transfer order id.
  - Fix: delete r.transfer_order_id in the purchaser branch.
  - Regression test: Purchaser GET asserts no transfer_order_id.

- [ ] **A2-16 / P3 / P3, not verified: [carryover BD-11] services/orderAdvance.ts and routes/sellOrders.ts import packing persistence from a route module**
  - Location: `apps/backend/src/services/orderAdvance.ts:15; apps/backend/src/routes/sellOrders.ts:49; apps/backend/src/routes/sellOrderPack.ts:38`
  - Evidence: import { prunePackRows } from '../routes/sellOrderPack' — service depends on HTTP registration (route->service->route cycle).
  - Failure: Structural: a change to sellOrderPack.ts route registration or its imports affects the archive lifecycle path; blocks an import-boundary check.
  - Fix: Move keyedLines/prunePackRows into services/sellOrderPack.ts; add an import-boundary lint.
  - Regression test: Existing sell-order-pack / orders-archive tests stay green; boundary check passes.

- [ ] **A2t-02 / P3 / P3, not verified: wave2b Fix 3b and Fix 3c pass whatever the PO back-advance guard does; the "Done sell order frees the line" branch is untested**
  - Location: `apps/backend/tests/wave2b-fixes.test.ts:245-284`
  - Evidence: Fix 3b (245-255) creates no sell order at all, so "forward advance is not blocked even with lines on sell orders" only tests a plain reviewing -> done. Fix 3c (257-284) moves done -> reviewing, a move Fix 3a (204-208) shows returns 200 even with an Awaiting-payment sell order on the line; the guard only bites at -> in_transit (209-216). The sell-order status calls at 274-277 are unchecked, so the SO may never reach Done.
  - Failure: A regression that makes the back-advance guard count Done sell orders as open commitments (blocking a legitimate PO revert to In Transit) or that stops checking commitments on forward moves passes both tests.
  - Fix: Fix 3b: attach an open sell order to a line before advancing forward. Fix 3c: assert each SO status call is 200, then advance done -> reviewing -> in_transit and expect 200.
  - Regression test: Mutate the guard to treat Done SOs as open; Fix 3c must fail.

- [ ] **A2t-03 / P3 / P3, not verified: Goods-total tests pass vacuously: the 0-to-NULL test starts at NULL and four "leave it alone" tests never check their PATCH succeeded**
  - Location: `apps/backend/tests/order-goods-total.test.ts:379-391; 112-117, 135, 226, 334`
  - Evidence: line() (line 25) sets no sellPrice, so sell_price is already NULL before the PATCH at 384-386 sends sellPrice: 0; the final toBeNull() holds even if the API stores 0 or ignores the field. The "leaves it alone" tests (e.g. 115 `await api('PATCH', … { notes })` with no status check) assert the total did not move, which a 400/409/500 also satisfies.
  - Failure: A route change that rejects notes-only PATCHes, or that writes 0 into sell_price (breaking the constraint the comment at 377-378 says the API never trips), leaves the suite green.
  - Fix: Price the line first (as inventory.test.ts:148 does) and assert each PATCH status is 200.
  - Regression test: Make the PATCH return 400; the four tests must fail.

- [ ] **A2t-04 / P3 / P3, not verified: Tests titled with "no writes"/"keeps X"/"unchanged" never check the mutation was attempted or that the named fields stayed**
  - Location: `apps/backend/tests/orders.test.ts:484-507; orders.test.ts:589-612; inventory.test.ts:390-408; item-types.test.ts:133-143; order-box-checks.test.ts:234-241; transfer-orders.test.ts:408-419,624-636; sellOrder-price-adjust.test.ts:306; wave2b-fixes.test.ts:111-118; suppliers-adopt.test.ts:53-56; orders-on-behalf.test.ts:160-178`
  - Evidence: orders.test.ts:504-506 fetches commissionRate and totalCost after the 409s but asserts only lines[0].qty. orders.test.ts:592 and 608 PATCHes are unchecked and the expected values (0, null) are the defaults. inventory.test.ts:399 PATCH unchecked and 406 allows before+1 events although the title says "writes no event". order-box-checks.test.ts:236 PUT unchecked and never shown stored before the DELETE. transfer-orders "409 (no writes)" check only transfer_orders.status, not the line's warehouse/status/transfer_order_id. suppliers-adopt.test.ts:53 uses find(...)! then ignores the adopt status.
  - Failure: A 409 that still commits commission_rate or total_cost (partial write before the refusal), or a line edit that moves a line's warehouse while returning 409, passes these tests.
  - Fix: Assert every setup/subject request status; assert every field the title names (commissionRate, totalCost, line warehouse/status); compare event counts with toBe(before) where the title promises none.
  - Regression test: Inject a write before the 409 return in the PATCH handler; orders.test.ts:484 must fail.

- [ ] **A2t-05 / P3 / P3, not verified: Negative-only scoping/filter tests have no positive control, so an endpoint that returns nothing passes**
  - Location: `apps/backend/tests/inventory-events-by-part.test.ts:81-93; inventory-products.test.ts:228-235; inventory-hide-pending.test.ts:84-94; orders-archive-stock.test.ts:103-105,554-556,604-606; orders-handoff.test.ts:593-611; orders-paypal-link-follows-id.test.ts:76-78; audit-m-low-fixes.test.ts:54-73`
  - Evidence: Each asserts an empty/absent result (toEqual([]), includes()===false, .some()===false) without first showing a manager/unfiltered call returns the row. orders-handoff 593-611 seeds no bank_transactions, so "links nothing" holds by construction; orders-paypal-link-follows-id 76-78 never shows the PO was linked before clearing.
  - Failure: A broken q filter, a purchaser-scoping bug that hides rows from everyone, or a PayPal link that never links leaves these green while users see empty pages.
  - Fix: Add the positive half (manager sees it / unfiltered list contains it / linked before unlink) before each negative assertion.
  - Regression test: Make the endpoint return [] unconditionally; each test must fail.

- [ ] **A2t-06 / P3 / P3, not verified: Lock-wait race tests rely on a fixed 300 ms sleep instead of waiting for the blocked backend**
  - Location: `apps/backend/tests/orders-stage-and-claim-races.test.ts:73-112; sell-order-edit-guards.test.ts:207-209`
  - Evidence: pause(300) stands in for "the request is now waiting on the lock". If the request reaches Postgres only after release() commits (slow runner, the 2026-10-31 baseline ran ~80x slower than normal), it sees the committed raise and refuses with the same 409/400, so the test passes with FOR UPDATE removed. review-lock-protocol.test.ts already has waitBlocked() polling pg_stat_activity/pg_locks for this.
  - Failure: Someone drops the row lock in the PO line-removal/archive path; under load the race tests still pass, and the oversell/strand bug they guard ships.
  - Fix: Replace pause(300) with the waitBlocked() helper (move it to tests/helpers) and assert the request was observed waiting before release().
  - Regression test: Remove FOR UPDATE in the guarded path; test must fail deterministically, not only on fast machines.

- [ ] **A2t-07 / P3 / P3, not verified: Count/metric assertions too weak to catch the regression they name**
  - Location: `apps/backend/tests/ref-price-events.test.ts:66-69; metrics.test.ts:30-41; observability.test.ts:70-73,107; order-serials.test.ts:230-249`
  - Evidence: ref-price-events asserts count >= 2 but seed.mjs inserts 12 events per ref_price, so a second appendPriceEvent that inserts nothing passes. metrics/observability "increments" tests match any counter value (\d+) with no before/after delta (observability.test.ts:110-146 does it correctly). order-serials asserts events.length > 0, which the create event alone satisfies.
  - Failure: appendPriceEvent stops writing history, or a metric stops incrementing, and the suite stays green.
  - Fix: Read the count before and assert toBe(before + n).
  - Regression test: Make appendPriceEvent a no-op; ref-price-events must fail.

- [ ] **A2t-08 / P3 / P3, not verified: Vacuous loops and silent early returns over possibly-empty results**
  - Location: `apps/backend/tests/pagination.test.ts:15,27,61,74,78; activity.test.ts:128,142; inventory.test.ts:37; transfer-orders.test.ts:144,526,764; me-realized.test.ts:62; stock-lock-order.test.ts:28`
  - Evidence: pagination asserts length <= 3 and loops over page B with no length check (78 compares createdAt strings, accepting ties). activity.test.ts:142 filters ?action=moved but the seed writes no transferred event, so the loop never runs. transfer-orders.test.ts:144/526 `if (!b) return;` and 764 `if (prior?.s) expect(...)` skip the assertion when data is missing. stock-lock-order.test.ts:28 `r.total === null ||`.
  - Failure: A cursor bug that returns an empty second page, or an action filter that drops inventory events, passes.
  - Fix: Assert non-empty (toBeGreaterThan(0)) before each loop; replace silent returns with expect(b).toBeDefined().
  - Regression test: Make page 2 return []; pagination tests must fail.

- [ ] **A2t-09 / P3 / P3, not verified: Wall-clock and calendar dependence in assertions**
  - Location: `apps/backend/tests/input-bounds-redos.test.ts:20,23,35,73,112; attachment-image-shrink.test.ts:14; suppliers.test.ts:173-174,215-217; semaphore.test.ts`
  - Evidence: input-bounds-redos asserts < 200 ms for 1000 regex runs on real time; attachment-image-shrink computes TODAY (UTC) once at module load and compares to server-dated filenames at 168; suppliers derives expected dates from Date.now() in UTC.
  - Failure: Flakes on a loaded runner (the baseline ran 80x slower) or when a run crosses UTC midnight; the ReDoS budget tests can fail spuriously, training people to rerun.
  - Fix: Use vi.useFakeTimers/vi.setSystemTime for dates; for ReDoS, assert step counts or use a generous budget relative to a baseline measured in the same test.
  - Regression test: Run with TZ and system time set to 23:59:59.900 UTC; tests must stay green.

- [ ] **A2t-10 / P3 / P3, not verified: part-merge test can pass without the migration rewriting any line**
  - Location: `apps/backend/tests/part-merge-per-category.test.ts:113-143`
  - Evidence: The RAM line is inserted with RAM_USCORE and the expected value is whatever ref_prices row won (138-141); line 102 accepts either spelling as winner. If the tie-break picks the spelling the line already carries, ram.part_number === winner.part_number with zero rewrites.
  - Failure: A migration change that stops re-spelling RAM lines passes this test whenever the line already uses the winning spelling.
  - Fix: Seed the RAM line with the spelling that must lose (assert winner != original first), then assert it changed.
  - Regression test: Delete the UPDATE order_lines step from the merge SQL; test must fail.

- [ ] **A2t-11 / P3 / P3, not verified: sell-order PO line number assertions compare null to null**
  - Location: `apps/backend/tests/sell-order-po-line-no.test.ts:43-53,79,88,93,100`
  - Evidence: Nothing asserts product_no is non-null or distinct; if inserted rows got NULL, noOf() returns null everywhere and every toBe(noOf(id)) and the sort check pass.
  - Failure: A trigger regression (0169) that stops assigning product_no leaves the test green.
  - Fix: expect(noOf(id)).not.toBeNull() and distinctness before comparing.
  - Regression test: Drop the BEFORE INSERT trigger in a test DB; test must fail.

- [ ] **A2t-12 / P3 / P3, not verified: /api/client-timings has no test**
  - Location: `apps/backend/src/routes/clientTimings.ts:46-83; apps/backend/src/index.ts:395-396,427`
  - Evidence: No file under apps/backend/tests references /api/client-timings (grep). Its auth gate, 20/min rate limit and loadEvent validation are untested; every other /api mount has at least one test.
  - Failure: A refactor of index.ts drops the authMiddleware lines for this mount; unauthenticated clients can then write arbitrary log lines (userEmail would throw, giving a 500 log flood) and nothing fails.
  - Fix: Add a small test: 401 without cookie, 400 without loadEvent, 204 on valid body, 429 after 20.
  - Regression test: That test.

## Limits

- **A2**: Out-of-lane carryover items (BD-01/03/04, SUP-04) were marked 'still open' only because A2 did not re-verify them, not because they regressed; other lanes own them. Source files were read in full (split across three reviewer passes, every P2 re-verified against the code by the lane owner). lib/sellOrderPriceTemplate.ts was only scanned (the shell treats it as binary; export-only). The ~150 test files in A2.files.txt were not reviewed one by one: only tier1-data-integrity.test.ts (BD-10) was read, and stock-lock-order/review-lock-protocol were checked for existence. No tests were run, because the backend baseline had not finished (no DONE in baseline/summary.txt) and no repro tests were written. Money: stored amounts are numeric(12,2) and the ::float use is display/export only, so no integer-cents defect was found beyond A2-07/A2-11. RS-483: the currency enum matches the DB CHECK, POST/PATCH validation agree, audit events carry currency, and old rows default to USD. No live resources touched.
- **A2t**: Baseline classification: all 44 failures (20 files) are load artefacts, none a real failure. 28 are 15 s test / 30 s hook timeouts (baseline Duration 1215 s vs ~15 s normal: the machine was saturated by parallel review lanes); the other 16 are the A2t-01 reset race firing in the test after each timeout. Every one of the 20 files passed alone on my own PG18 (review1031-A2t, 127.0.0.1:55621; 328/328 tests) and all 20 together at 8 forks twice (328/328, ~55 s each, load avg 11). Per-file verdicts in baseline_failures. The 4 fixtures (jpeg/pdf) were listed not inspected byte-wise; the 140 test files were read by three sub-readers with their top claims spot-verified by me (wave2b 3b/3c, order-goods-total, orders.test 484/589, ref-price-events, part-merge, race pauses, inventory 390, order-box-checks 234); lower-ranked items in A2t-04..A2t-11 location lists are reader-reported and not each re-verified. Static scan found no it.skip/only/todo. Per-file process.env mutations were not flagged: the forks pool runs each file in a fresh process. Not checked: frontend tests, tracker suites, CI workflow behaviour beyond backend-tests.yml env. Container review1031-A2t removed at the end.
