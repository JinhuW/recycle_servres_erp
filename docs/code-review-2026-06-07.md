# Deep Code Review — 2026-06-07

Whole-codebase review run module-by-module (20 modules) by parallel subagent
reviewers, with every **critical/high** finding independently re-verified by a
skeptic agent before it counted. 30 agents total; tests excluded from scope
(this reviews shipping code).

**Result:** no critical findings. **9 high-severity findings, all verified as
real** (zero false positives; two FX items were re-graded to medium during
verification but are genuine). The 7 strict highs + the FX-in-transaction issue
were **fixed in this pass**; one medium schema change was deliberately deferred
(see below). Mediums and lows are catalogued at the end for triage.

---

## Fixed in this pass

| # | Severity | Area | File | What |
|---|----------|------|------|------|
| 1 | high | data-integrity | `routes/orders.ts` | PATCH let any editor write an arbitrary `order_lines.status` (e.g. forge `Sold`/`Done`), defeating the lifecycle + sell-order guards. Status is no longer client-settable on the line-update or add-line path; it is lifecycle-driven only. |
| 2 | high | correctness | `routes/orders.ts`, `lib/pagination.ts` | Keyset cursor always compared `(created_at, id)` even when sorting by `total_cost`/`lifecycle`, silently skipping/duplicating rows across pages. Cursor now tracks the active sort column (with `id` tiebreaker; `total_cost` COALESCEd). API-only — the desktop UI sorts client-side. |
| 3 | high | data-integrity | `routes/sellOrders.ts` | `validateSellLines` checked each line against full stock independently, so two lines on one order sharing an `inventory_id` could oversell. Demand is now summed per source line before the qty check. |
| 4 | high→med | performance | `routes/sellOrders.ts` | Sell-order create/edit resolved FX **inside** `sql.begin`, so a cold-cache Frankfurter fetch ran while holding the SO id-counter + inventory row locks. FX is now resolved on the pooled client before the transaction. |
| 5 | high | data-integrity | `routes/vendorBids.ts` | Promote re-fetched the **live** FX rate instead of the rate **frozen on the bid**, so a CNY bid could become a sell order at a USD total different from what the manager approved and the vendor was quoted. Promote now uses `vendor_bids.fx_rate_to_usd`/`fx_source` (this also removes the in-transaction fetch). |
| 6 | high | security | `index.ts` | `app.onError` wrote the full request path to the durable error log; vendor portal paths carry a bearer-equivalent token (`/api/public/vendor/<token>/…`), leaking a replayable credential on any 500. The token path segment and sensitive query params are now redacted before logging. |
| 7 | high | data-integrity | `pages/desktop/DesktopSubmit.tsx` | Accepting a synthesized part number called `setLines()` then submitted synchronously from the **pre-update** closure, dropping the just-accepted part numbers (the inventory/pricing grouping key) and skipping the duplicate-PN check. Submit now builds a patched array and submits from it directly. |
| 8 | high | correctness | `VendorApp.tsx` | "My Offers" rendered CNY bid amounts with a hardcoded `$` (a ~7× misrepresentation of the vendor's own and the manager's accepted prices). Threaded the bid's `currency` through and render via `fmtMoney(amount, currency)`. |

**Regression tests added/strengthened:**
- `tests/orders.test.ts` — PATCH ignores a forged line `status` while still applying other edits (#1).
- `tests/sell-orders.test.ts` — duplicate-`inventory_id` lines whose summed qty exceeds stock are rejected (#3).
- `tests/vendor-bid-promote-fx.test.ts` — strengthened to move the live rate between submit and promote and assert the **frozen** rate is used (#5). Previously used the same mocked rate for both, so it never actually distinguished the two.

All workspace typechecks pass; backend integration suites for orders/sell-orders/vendor-bids/fx/pagination and the full frontend suite are green.

---

## Deliberately deferred (needs your call)

- **`fx_rates` missing `UNIQUE` + `ON CONFLICT`** (medium, `lib/fx.ts` / migration).
  `fetchAndStoreLatest` does a racy SELECT-then-INSERT. The naive fix —
  `UNIQUE(base, quote, effective_date)` — would **break the intentional
  manual-override ledger**, since a `manual` override and a `frankfurter` row
  legitimately share the same `(base, quote, effective_date)`. Verification also
  concluded the practical harm today is duplicate equal-valued rows (cosmetic),
  not wrong conversions. A correct fix would scope uniqueness to include
  `source` (and decide how repeated same-day manual overrides should behave) — a
  schema decision I didn't want to make unattended. Left for your review.

---

## Medium findings worth scheduling (not fixed)

These are real but either behavior-changing, lower-impact, or needing a product
decision — left for you to triage.

- **Realized-revenue reports drop sell lines with NULL `inventory_id`**
  (`routes/dashboard.ts`, `routes/me.ts`, `services/members.ts`). All three
  INNER-JOIN `order_lines` via the *nullable* `sell_order_lines.inventory_id`,
  so manually-added (non-inventory) sold lines silently vanish from manager
  KPIs, the profile lifetime stats, and the member leaderboard — and disagree
  with `customers.get('/')` (which LEFT-JOINs). Fix is a consistent LEFT JOIN +
  `COALESCE(unit_cost,0)`. **Behavior-changing (numbers will move), so wants
  your sign-off.**
- **Transfer CSV is open to spreadsheet formula injection**
  (`pages/desktop/DesktopTransfers.tsx`). Client-built CSV quotes cells but
  doesn't neutralize a leading `= + - @`; Item/From come from OCR/user input.
  Prefix risky cells before quoting.
- **Warehouse delete silently NULLs location on all live inventory/sell lines**
  (`routes/warehouses.ts`) with no audit/warning. Should refuse (409) when live
  stock exists unless `transferTo` is given.
- **Grouped `/products` truncates facets/totals/warehouse counts at
  `RAW_CAP=2000`** (`routes/inventory.ts`) — summary numbers a manager trusts go
  silently wrong above 2000 lines. Compute aggregates in SQL or return a
  `truncated` flag.
- **`amountInWords` can print "One Hundred Cents"** (`lib/pdf.ts`) and contradict
  the numeric invoice total. Round to cents once before splitting dollars/cents.
- **Dashboard category leaderboard filter is a no-op** that relabels
  all-category data as category-scoped (`DesktopDashboard.tsx`). Disable the
  control or pass the category to the backend.
- **`DualLineChart` emits NaN SVG paths for single-sample market rows**
  (`DesktopMarket.tsx`); guard `sell.length < 2`.
- **Sell-order editor save ordering** fires the status transition before the
  line/customer PATCH (`DesktopSellOrders.tsx`); advancing to a terminal state
  then rejects the edit while reporting "save failed". Send the PATCH first.
- **`set_market_price` / market reads pick an arbitrary duplicate row**
  (`mcp/tools/market.ts`, `lib/marketWrite.ts`) — add `ORDER BY updated_at DESC`.
- **MCP errors leak raw exception messages** to external clients
  (`mcp/server.ts`), bypassing the app-wide error sanitization.
- **`revokeOAuthClient` multi-table write isn't transactional**
  (`oauth/clients.ts`) — a crash mid-cascade can strand live refresh families
  for a "revoked" client. Wrap in `sql.begin`.
- **`sell_order_events` append-only trigger (migration 0050)** omits the
  cascade-depth exception 0038 added for sibling audit tables — latent: a future
  `DELETE FROM sell_orders` would abort. Mirror 0038 in a new migration.
- **Activity drawer swallows fetch errors into a false-empty audit log**
  (`DesktopActivityDrawer.tsx`) — dangerous on an audit surface; route through
  `handleFetchError`.
- **`partNumberSynth` positional ambiguity** (`packages/shared`) — a blank middle
  segment can collapse two distinct SSD lines to the same synthetic key
  (inventory/pricing collision).
- **Activity-log fetch failure logs out an authenticated user**
  (`lib/auth.tsx`) — `/api/me` has no per-promise catch in the bootstrap
  `Promise.all`, so a transient non-401 boots a valid session to login.
- **Members/Customers settings tabs shown to purchasers** though their APIs are
  manager-only (`DesktopSettings.tsx`) — dead 403-ing tabs.
- **Warehouse "Accepting receipts" toggle shows a fabricated value**
  hardcoded off the short code (`WarehousesPanel.tsx`).
- **`OrderActivityLog` ships hardcoded English** while computing a zh locale for
  numbers/dates — diverges from the correctly-localized `SellOrderHistory`.

## Lows (convention/robustness backlog)

Predominantly **raw English strings bypassing `useT()`** across several desktop
pages/components (`DesktopSellOrders`, `DesktopInventory`, `DesktopActivityDrawer`,
`DesktopDashboard`, `DesktopSubmit`, settings panels, `OrderActivityLog`,
`VendorApp` error fallback), plus: in-memory scan rate-limiter leak/multi-instance
gap (`routes/scan.ts`); double-buffered upload body per scan; orphaned R2 label
objects; `decodeCursor` doesn't validate shape; an unindexed FK
(`vendor_bid_lines.sell_order_id`); non-idempotent migration 0065; `t()`
interpolation replaces only the first placeholder occurrence; negative-price
inputs accepted client-side; client upload cap hardcoded; coupled password
visibility toggle; email stored lowercased-but-not-trimmed in `createMember`
(can lock out login); email-only login throttle (targeted lockout DoS); and a
handful of brittle substring-matched error classifications (`orders.ts` FK 409,
`DesktopInventoryEdit` 409 banner).

Overall the codebase is in good health: parameterized SQL throughout, the shared
pool + `sql.begin`/`notify` atomicity conventions are well respected, auth/CSRF
and OAuth are sound, and vendor public endpoints scope correctly to the link
(no IDOR found). The fixed highs were concentrated in money/FX handling, the
order line-status guard, and one credential-logging leak.
