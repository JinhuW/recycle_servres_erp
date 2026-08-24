# Deep Code Review — 2026-08-24

Whole-codebase review (xhigh effort): 10 parallel finder angles produced 68
raw candidates; every surviving finding was adversarially re-verified before
it counted (1 refuted, 4 graded plausible-only, the rest confirmed).  This
pass **fixed only the dead-code / stale-docs items** the review was asked to
clean up; the correctness findings below are verified but **not yet fixed** —
they are the triage backlog for follow-up sessions.

---

## Fixed in this pass (cleanup)

- **~50 orphaned i18n keys** removed from both `i18n.tsx` (en) and
  `i18n.zh.ts` — zero references anywhere outside the dictionaries.  The
  dynamically-built key families (`dim_<key>`, `soCloseReason_<id>`,
  `fbcState_<state>`) were kept: they never appear as full literals, so a
  whole-word search wrongly flags them (see the comment above the dict).
- **Dead endpoints removed**: `GET /api/inventory/aggregate/by-part` (its
  comment claimed it powered QuickView — QuickView actually calls
  `events/by-part`), `GET`+`DELETE /api/attachments/:id`, and
  `POST /api/notifications/:id/mark-read` (the UI only ever calls the bulk
  `mark-read`; its test now exercises the bulk path).
- **Dead service-worker route removed**: the BackgroundSync queue for
  `POST /api/attachments` — no frontend code issues that request.  The now
  unused `workbox-background-sync` and the never-used `workbox-expiration`
  deps dropped from `apps/frontend/package.json`.
- **Unused export** `primaryPhoto` removed from `lib/linePhotos.ts`.
- **Stray 151 KB screenshot** `connectors-collapsed.png` removed from the
  repo root.
- **Stale comments/docs corrected**: `qr.ts` comments still justified the
  crop cap by "jsQR's per-frame cost" (jsQR is long gone); README/CLAUDE.md
  claimed 41 migrations (actual 96 and counting — counts replaced with
  "highest-numbered file is the head"); README claimed ~60 test files run
  serially (actual 132, run in parallel per `vitest.config.ts`).

Verification: `pnpm typecheck` green; frontend suite 295/295; backend suite
132 files / 1083 tests green.

---

## Open verified findings (not yet fixed) — most severe first

| # | Area | File | What |
|---|------|------|------|
| 1 | money / race | `routes/shipments.ts:528` | Label **buy** applies the shipping fee without re-checking `status`/`fees_applied` inside the tx — concurrent duplicate buys permanently double-charge `orders.other_fees`.  `services/shipmentVoid.ts` models the fix (`SELECT … fees_applied FOR UPDATE`); buy never consults it. |
| 2 | auth | `routes/me.ts:169` | The `rt` cookie is path-scoped to `/api/auth`, so `/api/me/password` can never see it → the keep-current-session branch is dead and **every self password change revokes the user's own session** (forced logout ≤15 min later via reuse detection). |
| 3 | auth | `auth.ts:150` | Zero tolerance for a benign concurrent refresh: two tabs presenting the same `rt` within one round trip trip theft detection and revoke the whole family — both tabs logged out with no attack.  Needs a short grace window honoring the immediate successor. |
| 4 | reporting | `routes/dashboard.ts:70` | KPI revenue/profit, Done-order count and per-category rollups `INNER JOIN` `sell_order_lines → order_lines` on nullable `inventory_id`, silently excluding **manual** sell-order lines.  Dashboard disagrees with the sell-orders screen. |
| 5 | validation | `routes/vendorBids.ts:148` | Bid decide never validates `acceptedQty` against the vendor's `offered_qty` (clamps only to stock; not at all for manual lines) — a bid can be accepted, then promoted, for far more units than were offered. |
| 6 | data-integrity | `routes/orders.ts:1304` | PO PATCH edits qty/unit_cost of lines committed to Shipped/Awaiting-payment sell orders with no sell-commitment guard — inventory PATCH 409s the identical edit for exactly this reason. |
| 7 | pagination | `DesktopSellOrders.tsx:231`, `DesktopOrders.tsx:171`, mobile `Orders.tsx`, mobile Market | List pages fetch one default page (50 rows) and never consume `nextCursor` — at >50 orders, older live orders silently vanish from inboxes, stat tiles, KPI totals and client-side search. |
| 8 | validation | `routes/orders.ts:795` | POST /api/orders inserts line qty/unitCost raw (badLine() gates exist only on PATCH): a typo'd **negative unit cost** from the normal desktop UI is stored silently and corrupts profit/commission; qty 0 / 1.5 surface as 500s off the DB CHECK. |
| 9 | data-integrity | `routes/inventory.ts:1390` | Partial warehouse-transfer split clones a line **without serial/chip numbers** — moved units lose identity permanently and the source line violates serials-equal-qty on its next edit. |
| 10 | mobile scanner | `lib/qr.ts:94` + `vite.config.ts` | zxing wasm is excluded from the PWA precache and every decode/load failure is swallowed — on iPhone PWA (no BarcodeDetector) a stale deploy or flaky network leaves the scanner silently dead: camera live, decoding nothing, no error, no retry. |
| 11 | security | `routes/shipments.ts:175` + `index.ts:292` | Unauthenticated seller-fill accepts unbounded package numbers → NUMERIC overflow 500; the error-log redaction covers only `/api/public/vendor/…`, so each such 500 writes the **replayable seller token** into `errors.jsonl`. |
| 12 | honesty / UX | `routes/coordinator.ts:68` + `DesktopCoordinator.tsx:475` | A 200 non-JSON upstream (CF Access login page) flows through as 200 → dashboard renders bundled **sample numbers as live data with no badge**; a 502 opens a blocking error dialog re-fired by the unguarded 30 s poll. |
| 13 | mobile UX | `pages/OrderDetail.tsx:248` | Mobile offers purchasers an enabled "advance to Reviewing" on In Transit POs that `services/orderAdvance.ts:60` categorically 403s — the goods-arrived flow on mobile always ends in an error dialog for purchasers.  Desktop gates it correctly. |
| 14 | authz leak | `routes/inventory.ts:993` | GET /api/inventory/:id strips cost/profit from the item for purchasers but returns `inventory_events` unfiltered — edit events carry `unitCost` from/to, leaking exactly what was redacted.  The sibling by-part events route already scopes this. |

## Below-the-cap queue (also verified)

Inventory PATCH has no status allowlist and a coercing health check that lets
`"abc"` 500 on the NUMERIC cast (`inventory.ts:1138`, `:1046`); unvalidated
`::timestamptz`/`::uuid`/sort-cast interpolation 500s from crafted or
sort-switched cursors and raw `since`/`actor` params (`lib/pagination.ts:29`,
`orders.ts:276`, `activity.ts:61`); vendor bid POST does a live Frankfurter
fetch in-request when `fx_rates` is empty (`lib/fx.ts:62`); `scan.ts:51`
hard-codes the category whitelist and ignores the `ai_capture` flag;
image-shrink uses pre-rotation EXIF dimensions (`lib/image-shrink.ts:23`);
`DB_POOL_MAX` typo crashes every request via `Array(NaN)` (`db.ts:30`);
duplicate member email 500s instead of 409 (`members.ts:66`); `unreadCount`
computed from the newest 50 rows only (`notifications.ts:22`);
DesktopAnalysis status colors swapped vs the canonical `statusTone` map;
~150-line duplicated status-evidence upload trio (`orders.ts:1749` vs
`sellOrders.ts:868`); efficiency: marketWrite issues ~2000 serial queries per
500-row batch, validateSellLines queries per-line under the SO counter lock,
both order detail routes run four sequential queries, tracker/coordinator
30 s polls don't pause when hidden.  Plausible-only latents: `/api/market/
values` edge exemption fail-open shape, `id-seq` unguarded `rows[0]`, CORS
missing PUT, same-second error-log rotation clobber.

One candidate was refuted: the `'Mixed'` category literal in `packages.ts` is
the documented zero-line-draft convention, not a bypass.
