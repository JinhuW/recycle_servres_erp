# Finance — review 2026-10-31

Lanes: A3 (Backend finance). 12 findings: 0 P1 / 1 P2 / 11 P3. Severity shown is after verification; P3s were not verified.

## P2

- [ ] **A3-01 / P2 / confirmed: Manual FX override has no upper bound; a typo becomes the rate every CNY sale and USD book entry uses**
  - Location: `apps/backend/src/routes/fxRates.ts:65; apps/backend/src/lib/fx.ts:142-162,76-92; apps/backend/src/routes/accounting.ts:781,871; apps/backend/migrations/0191_accounting_entries.sql:18`
  - Evidence: POST /api/workspace/fx-rates only checks rate > 0 (fxRates.ts:65), and storeManualOverride only checks finite/positive. getLatestRateToUsd returns the newest row by fetched_at, so the override becomes 'latest' at once. Its readers: sellOrders.ts:803/911 converts every CNY sell line with it, market.ts:344 converts CNY price imports, and accounting.ts:781/834 stamps it on USD entries that send no fxRate. accounting_entries.fx_rate has CHECK (fx_rate > 0 AND fx_rate <= 100), and validateFields caps a client rate at MAX_RATE=100 (accounting.ts:66,619), so the two writers of the same number disagree.
  - Failure: A manager types 7100 for 7.10 on the FX page and gets a 201. Until someone notices, a CNY sell order saved in that window stores unit_price = ¥ × 1/7100 (about 1000x too low), and that USD figure goes straight into dashboard revenue and profit. Every RMB Flow entry in USD without an explicit rate fails the CHECK and returns a 500. A rate under 5e-9 rounds to 0 in NUMERIC(18,8) and 500s on fx_rates' own CHECK. Repro A3-01 confirms the 201 then the 500.
  - Fix: Validate at the boundary with the bound the book already uses: 0 < rate <= 100, or a sanity band around the latest frankfurter rate (for example ±20%) that needs explicit confirmation. Share one constant with accounting's MAX_RATE. Consider a CHECK on fx_rates.rate too.
  - Regression test: fx-routes.test.ts: POST rate 7100 returns 400 and stores no row; POST 0.000000001 returns 400; a valid override still returns 201 and is used by a USD accounting entry with no fxRate. Repro: docs/review-2026-10-31/repro/A3/a3-repro.test.ts (asserts current defect; passed 2/2).
  - Verifier: repro/A3-verify/a3-01-fx-override.test.ts (run log repro/A3-verify/run.out.txt, 3/3 pass on disposable PG18 :55703): POST /api/workspace/fx-rates {quote:'CNY', rate:7100} -> 201; a CNY sell order line of 710 CNY is then stored with unit_price = 0.10 USD (should be ~100); POST /api/accounting/entries in USD with no fxRate -> 500 'accounting_entries_fx_rate_check' (accounting.ts:795); rate 1e-9 -> 500 'fx_rates_rate_check' from storeManualOverride (fx.ts:151). Code: fxRates.ts:65 and fx.ts:149 check only finite && > 0; fx_rates CHECK (0056) is only rate > 0; frontend FxRatesPanel.tsx:72 and input min="0" add no upper bound. (Could not disprove: no layer bounds the override above. The accounting module already refuses an explicit fxRate of 7100 with a 400 (tests/accounting.test.ts:144) and its column CHECKs <= 100, so the missing bound on the ledger that feeds it is an inconsistency, not a design choice. A one-keystroke manager typo silently corrupts frozen USD snapshots on new CNY sell orders and turns USD RMB-Flow entries into 500s; P2 stands (manager-only, needs a typo, but the damage is persisted money figures).)

## P3

- [ ] **A3-02 / P3 (raised as P2) / confirmed: Archived POs still count in the purchaser projection, the leaderboard and the contribution revenue/profit cards, though spend and Home exclude them**
  - Location: `apps/backend/src/routes/dashboard.ts:59-62,268-287; apps/backend/src/services/contributions.ts:69-70,132`
  - Evidence: spendWin adds po.archived_at IS NULL (dashboard.ts:68-72), and its comment says 'An archived PO is out of every stock and cost reader'. projDateWin and projPrevWin (:59-62) don't add it, and neither do the leaderboard's per_order/per_line CTEs (:274,:285) or contributions' `reviewed` (contributions.ts:69-70, used for the purchaser revenue/profit and the PO count). Home's commission figure filters archived (home.ts:39 `mine`), so Home and the dashboard state different commission for the same purchaser. Only spend has a test for archived exclusion (dashboard-contrib.test.ts:141).
  - Failure: A manager archives a Done PO that was a duplicate entry. The purchaser's dashboard keeps its projected revenue, profit and commission in the KPI tiles, the profit and revenue cards and the chart. The leaderboard keeps its cost and commission for every viewer, so the purchaser ranks higher and the manager reads inflated commission owed. Meanwhile the spend card, the chart's cost bars and Home leave it out. Repro A3-02 (archived Done PO, cost 100, sell 200, rate 0.1): contrib.cost.total = 0, but kpis.commission = 10, kpis.profit = 100 and leaderboard cost/commission = 100/10.
  - Fix: Put `po.archived_at IS NULL` in one shared 'reviewed and live' fragment and use it in projDateWin/projPrevWin, both leaderboard CTEs and contributions' `reviewed`. The manager realized lens joins POs through sale lines and should stay as is: an archive pulls lines off open sell orders, and a Done sale is history.
  - Regression test: dashboard-projected.test.ts: an archived reviewed PO adds nothing to the purchaser KPIs, the series, contrib revenue/profit/count or the leaderboard, and its unarchive restores it. Repro: docs/review-2026-10-31/repro/A3/a3-repro.test.ts (asserts current defect; passed 2/2).
  - Verifier: repro/A3-verify/a3-02-archived-po.test.ts (2/2 pass): archived Done PO for Marcus (total_cost 100, line cost 100 / sell 200, rate 0.1). Purchaser GET /api/dashboard?range=7d -> contrib.cost.total = 0 but kpis {cost:100, revenue:200, profit:100, commission:10}, contrib.profit.total = 100, own leaderboard row cost 100 / commission 10. Manager view: contrib.cost.total = 0, Marcus's leaderboard row cost 100 / commission 10. Code: dashboard.ts:59-62 (projDateWin) and :274/:285 (leaderboard CTEs) have no archived_at filter, while spendWin dashboard.ts:69-71 and contributions.ts:73 do; contributions.ts:69-70 'reviewed' has none. (The mismatch is real and reproduced: the same archived PO is out of spend but in the projected KPIs, profit/revenue cards and leaderboard cost, contradicting dashboard.ts:66-67 ('An archived PO is out of every stock and cost reader'). Downgraded to P3 because archiving is documented as keeping business records for 'commission history' (routes/orders/lifecycle.ts:168-171): a Done PO's commission was owed and paid, so keeping it in commission/profit is defensible; the defect narrows to leaderboard/KPI cost disagreeing with the spend card for the rare archived-after-review PO, a display inconsistency with no persisted money effect.)

- [ ] **A3-03 / P3 / P3, not verified: The dashboard fans out about 19 queries at once with Promise.all, against the pool's max of 10 and the backend's 4-at-a-time rule**
  - Location: `apps/backend/src/routes/dashboard.ts:112-345; apps/backend/src/services/contributions.ts:114,154`
  - Evidence: apps/backend/AGENTS.md: 'Fan out per-request reads with allLimited, at most 4 at a time. The prod pool is max: 10 and postgres.js pipelines past it onto busy connections, so an unbounded Promise.all on a hot page queues other requests behind it.' dashboard.ts:113 runs 9 queries in one Promise.all, and the ninth is contributions(), which runs another 11 (manager) or 8 (purchaser) in its own Promise.all (contributions.ts:114,154). db.ts:33 sets max 10.
  - Failure: A manager opens or changes the dashboard range, and up to 19 aggregate queries (several with LATERAL fee joins over order_lines) take all 10 pool connections. Requests from other users, such as a purchaser's PO save, wait behind them. Each range click repeats it.
  - Fix: Use allLimited for both fan-outs (and for market.ts:76/335 for consistency). Better still, fold the contributions queries into fewer GROUPING SETS statements.
  - Regression test: None functional. A lint or grep check for Promise.all over sql in routes/services, or a test that spies on pool concurrency.

- [ ] **A3-04 / P3 / P3, not verified: A payment equal to goods plus fees never ranks 'exact', so the true match never gets the one-click Link**
  - Location: `apps/backend/src/banktx/match.ts:438-440,456,472-486`
  - Evidence: amountDateFrag admits a PO when the payment equals total_cost or total_cost + other_fees (match.ts:145-147), and the SQL pool orders by the nearer of the two (:547-548). rankCandidates then sets diff = total_cost - amount and exact = |diff| < 0.005 on goods only (:438-440), so a goods+fees match is 'near' and gets confidence 'low' (or 'medium' with a seller name). DesktopPayments.tsx:834 arms the one-click link only for count===1 && confidence==='high'. banktx-match.test.ts:270-275 pins amountDiff = -105 for that case without asserting confidence.
  - Failure: A PO with $3,450 of goods and $105 of fees is paid with exactly $3,555 two days later. It is the only candidate, but the row shows a low-confidence 'near' suggestion with a −$105 diff. The manager has to open the picker and confirm by hand what the matcher already found, and 'covered' compares only against goods, so a fee-bearing PO reads covered early.
  - Fix: Compute exact against both bases (goods and goods+fees, the one the SQL ranked by) and report amountDiff against the nearer one. Use goods+fees for `covered`.
  - Regression test: banktx-match.test.ts: the goods+fees case returns reason 'exact', confidence 'high' and amountDiff 0.

- [ ] **A3-05 / P3 / P3, not verified: /unassign and /note write a payment group from an unlocked read, unlike every other verdict**
  - Location: `apps/backend/src/routes/bankTx.ts:1090-1098,1106-1131`
  - Evidence: Every other mutation calls lockBankGroupTx and then groupOf inside sql.begin. bankTx.ts:967-970 explains why: 'judged on a pool read, a /link that committed in between left a row both linked and a transfer'. /unassign and /note run groupOf on the pool and then UPDATE `id IN (ids read)` outside a transaction.
  - Failure: A manager writes a note on a Mercury leg while another manager groups it with its PayPal leg. /note read the group as [mercury]. /pair locks both legs, sees one note and copies it (bankTx.ts:689-694), then commits. The note UPDATE runs after it and rewrites only the Mercury leg. The feed shows the PayPal leg's older copy, so the new note is invisible until someone ungroups. /unassign racing /pair leaves the PayPal leg still assigned in the same way.
  - Fix: Wrap both in sql.begin with lockBankGroupTx + groupOf, as /assign does.
  - Regression test: A barrier test: hold the group lock, start /note, pair the legs, release. Both legs end with the new note.

- [ ] **A3-06 / P3 / P3, not verified: Links judge the target PO/SO's archived or closed state without locking it**
  - Location: `apps/backend/src/routes/bankTx.ts:516-531; apps/backend/src/banktx/sync.ts:685-693`
  - Evidence: /link reads `SELECT archived_at FROM orders WHERE id = … LIMIT 1` (and the SO status) with no FOR KEY SHARE / NO KEY UPDATE, then updates bank_transactions. linkPaypalTxnToOrder checks payment='company', not cash, not archived and not contested on an unlocked read before the conditional bank-row UPDATE. The FK only takes KEY SHARE, which a non-key archive UPDATE doesn't conflict with.
  - Failure: A manager links a payment to PO-X while another manager archives PO-X (or switches it to self-paid, or closes the SO). Both commit, and the payment ends up linked to an archived PO, which every money reader skips. The payment drops out of the Unlinked queue and the PO's paid figure. The UI refuses exactly this state.
  - Fix: Lock the target row (FOR NO KEY UPDATE) inside the transaction and re-check archived, closed or payment on the locked row. Use one documented order, orders before bank rows, in both /link and linkPaypalTxnToOrder.
  - Regression test: A barrier race: archive vs /link ends with either a refused link or an unarchived linked PO, never both archived and linked.

- [ ] **A3-07 / P3 / P3, not verified: Market search treats % and _ as wildcards**
  - Location: `apps/backend/src/routes/market.ts:58-64`
  - Evidence: `LOWER(rp.label) LIKE '%' || ${search} || '%'` with the raw query. escapeLike is imported (market.ts:7) and used by /parts, but not here.
  - Failure: A search for a part number with an underscore, such as 'HUS724040ALE_640', matches any character in that position. A search for '%' returns the whole board and the total count.
  - Fix: Pass escapeLike(search) here as /parts does.
  - Regression test: market-pagination.test.ts: q='_' returns only labels or PNs that contain an underscore.

- [ ] **A3-08 / P3 / P3, not verified: A manual price of 0 is accepted and zeroes the part's max buy, the case the importer refuses**
  - Location: `apps/backend/src/routes/market.ts:455; compare market.ts:362-365,423`
  - Evidence: /:id/manual-price accepts price >= 0 with no upper bound. The import path treats 0 as 'not buying', because 'as a price it would zero the part's max buy' (market.ts:362-365), and caps prices at 10,000,000 (:423). formatRefPrice uses last_price as the maxBuy basis (lib/market.ts:93), and a 0 is not null, so it overrides avg_sell.
  - Failure: A manager clears a price by entering 0. The part's maxBuy reads $0.00 on every PO intake lookup (/lookup), and purchasers see a recorded max buy of zero for a part that sells.
  - Fix: Require price > 0 (and the import's ceiling) on manual entry, or give 'not buying' its own explicit state.
  - Regression test: market-manual-price.test.ts: price 0 returns 400.

- [ ] **A3-09 / P3 / P3, not verified: Market 'Internal sales (30d)' averages archived and Draft PO lines**
  - Location: `apps/backend/src/lib/market.ts:150-161`
  - Evidence: The internal_sales CTE filters o.created_at >= NOW() - 30d and sell_price IS NOT NULL only. There is no archived_at or lifecycle filter, unlike every other money reader (/chips filters o.archived_at IS NULL at market.ts:263).
  - Failure: A duplicate PO, archived, still adds a sample to a part's internal average, and so does a Draft line with a mistyped sell price. Purchasers read that average as the team's selling price.
  - Fix: Add o.archived_at IS NULL and, if intended, o.lifecycle <> 'draft'.
  - Regression test: market-internal-sales.test.ts: an archived PO's line does not change avgPrice or samples.

- [ ] **A3-10 / P3 / P3, not verified: [cross-lane] CNY sell lines store a per-unit USD price rounded to cents, so realized revenue drifts with quantity**
  - Location: `apps/backend/src/routes/sellOrders.ts:911,1357; apps/backend/src/lib/fx.ts:45-47; apps/backend/migrations/0002_desktop.sql:45`
  - Evidence: convertToUsd rounds amount×rate to 2dp per unit, and unit_price is NUMERIC(12,2). The dashboard and contributions sum sol.unit_price*qty (dashboard.ts:119, contributions.ts:88), and the bank SO picker's exact match uses the same figure (bankTx.ts:1231).
  - Failure: A CNY sell order of 1,000 units at ¥1.00 with a rate of 7.2 stores $0.14 per unit, so the dashboard shows $140.00 against $138.89 actually invoiced (+0.8%). The bank row for $138.89 is never 'exact' against that sell order.
  - Fix: Store the USD line total, or keep 4+ decimal places on unit_price for converted lines, and round only the line total.
  - Regression test: A sell order in CNY with qty 1000 at ¥1.00 has a line total within $0.01 of ¥1000/7.2.

- [ ] **A3-11 / P3 / P3, not verified: The booking rate and the review ledger rate pick 'latest' by different keys**
  - Location: `apps/backend/src/lib/fx.ts:76-84 vs 55-63`
  - Evidence: getLatestRateToUsd orders by fetched_at DESC and ignores effective_date. cnyPerUsdOnFrag, which Review mode's ledgerRate check uses (accounting.ts:1300), orders by effective_date DESC, fetched_at DESC.
  - Failure: The refresh loop inserts a frankfurter row for an older effective date (for example after a gap, before ECB publishes) after a manager's same-day manual override. USD entries are then booked at the frankfurter rate while the review check compares them with the override. A correct entry gets a rate-mismatch warning, or a wrong one escapes it.
  - Fix: Pick the latest rate one way for both: by effective_date, then fetched_at.
  - Regression test: An fx unit test with a manual row for today, then a frankfurter row for yesterday fetched later: both readers return the same rate.

- [ ] **A3-12 / P3 / P3, not verified: POST /internal-transactions/:id/members checks the record outside the transaction**
  - Location: `apps/backend/src/routes/internalTx.ts:287-290`
  - Evidence: The record's existence is read on the pool, then sql.begin(addMembers) writes internal_txn_id = id. Nothing locks the internal_transactions row.
  - Failure: A manager deletes the record while another adds a member. The member UPDATE then hits an FK violation and the API returns a 500 instead of a 404.
  - Fix: Read the record FOR KEY SHARE inside the transaction.
  - Regression test: A barrier test: delete racing add returns 404, not 500.

## Limits

- **A3**: I read every source file in A3.files.txt in full. I read the test files for the cases the findings name (banktx-match, accounting, dashboard-contrib, dashboard-realized, fx-routes, market-manual-price) and skimmed the rest by grep, not line by line. Commission rule check: orders.payment is CHECK IN ('company','self') (0143), accounting.ts's CostRow types it as 'company'|'self', and no route in this lane adds, removes or renames a payment type. The commission_paid_by_company flag and the bank commission link are both the 'Company pay' side, so the rule holds. Pagination: accounting /entries, bankTx / and internalTx / use keyset cursors with limit+1. Market GET / uses OFFSET with an id tiebreak and a full-filter total. Review lists cap at 500 and flag truncation. Bank and dashboard money is rounded to cents only at the response edge (r2dp), and amount_cny is a generated ROUND(amount*fx_rate,2). Not checked: the PayPal and Mercury live APIs (no calls made), the prod DB (no query needed for this lane), the frontend presentation of these figures (other lanes), and whether a Done PO's fees or lot price can still be edited after a sale (that decides how much the open ARCH item bites; it belongs to the orders lane). Baseline: backend-test.log shows timeouts (~30s) across many files, including bank-transactions-sync ('clears the badge when the payment settles', 'keeps fetching back to the oldest row still pending'). They look load-induced, since every review lane runs at once, and I don't report them as findings. Repros are in docs/review-2026-10-31/repro/A3/a3-repro.test.ts (A3-01, A3-02) — run after baseline DONE against a private postgres:18 (review1031-A3, port 55603, since removed) with a scratchpad vitest config rooted at apps/backend: 2/2 passed in 5.4s, confirming both defects on 62f53dec. Nothing was copied into apps/.
