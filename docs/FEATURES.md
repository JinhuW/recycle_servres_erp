# What the ERP does today

`CHANGELOG.md` says when things changed. This says what exists **now**, by
area, with the version each behaviour arrived in so you can read the entry
that introduced it.

Written for whoever — human or agent — has to change this system without
having watched it get built. It describes behaviour, not implementation:
`CLAUDE.md` covers conventions and tripwires, and the route files are the
source of truth for endpoints.

Keep it current: when a change adds, removes or reshapes user-visible
behaviour, edit the bullet here in the same PR and cite the new version.

---

## Roles and access

Three roles: **manager**, **purchaser**, and unauthenticated **vendors** who
reach a portal through a URL token.

- Managers see everything. Purchasers see the buying side — dashboard, submit,
  history, shipping, clients, market, settings — and their own POs.
- Desktop role gating is three-layered: the sidebar's `roles` list, a
  `DesktopApp` view bounce, and in-page filters. Missing one leaves the view
  invisible rather than forbidden.
- Auth is httpOnly cookies — a 15-minute `at` JWT plus a rotating `rt` refresh
  family. No localStorage, no bearer tokens. Refresh-token reuse revokes the
  whole family.
- Every mutating request carries `X-Requested-By: recycle-erp`; the CSRF guard
  drops it otherwise. Exempt: safe methods, `/api/health`, and `/api/public/*`
  (vendor endpoints, which authenticate by URL token instead).
- Managers can reassign a PO's purchaser until it is Done (v1.84.0) and submit
  a PO on behalf of one (v1.82.0).

## Purchase orders

The core object. A PO is a purchase from a vendor, built line by line, that
moves Draft → Submitted → In Transit → Reviewing → Done.

- **One PO can hold several categories** (v1.54.0), with its lines grouped by
  category and a per-category cost breakdown (v1.55.0).
- **Purchasers edit until Done.** A material edit sends the PO back to Draft
  and raises a change-review dialog for the manager, showing the full field and
  line diff (v1.97.0). Notes, photos and attachments don't trigger it. A
  reverted order is a Draft that was already submitted, so deleting it archives
  rather than wipes.
- **A company-paid PO names the payment that funded it before it leaves
  Draft** (v1.115.0) — the transaction ID is required, and the advance is
  refused without it for every actor, a manager stage-jump and carrier movement
  included. Self-pay POs are unaffected. The rule governs only orders created
  after it reached the environment, so POs already on file stay exempt. Mobile
  gained the field as an input; it used to be read-only there.
- Managers can reopen a Done PO back to Reviewing (v1.81.0).
- **Costs split into a goods total and other fees** (v1.43.0); a goods overflow
  can be moved into Other fees (v1.45.0). Fees amortize per line, which is what
  commission is calculated from. `orders.category` and `orders.total_cost` are
  **derived from the lines** — clients must not send `totalCost`.
- Line specs are per-category: RAM carries Part #, Chip #, Brand, Capacity,
  Generation, Type, Class, Rank and Speed; SSD/HDD carry Interface, Form
  factor, Health % and RPM; Other carries a free item type (v1.47.0).
- **Validation is shared between shells**, so desktop, mobile and the backend
  can't drift: all RAM spec fields required (v1.29.0); Chip # required only for
  Micron and Other, whose part numbers don't identify the module (v1.36.0);
  DDR5 lines must carry serial numbers, and once any line has serials their
  count must equal the line qty (v1.42.0); SSD lines drop health/serials and
  require brand above 800 GB (v1.76.0).
- **Part numbers are canonical** — one part number however it was typed
  (v1.104.0) — and the submit form suggests existing ones as you type
  (v1.101.0).
- Lines carry photos (v1.54.0). Submission attachments accept receipts and
  spreadsheets (`.xlsx`, `.csv`); `.xls` and `.xlsm` stay refused (v1.34.0).
- The PO list hides Done orders by default with a toggle (v1.89.0); mobile
  managers see the whole org's POs (v1.88.0). The stage filter lives in the
  table toolbar as status chips (v1.39.0).
- **Every change is audited**, drafts included (v1.33.0), and each timeline
  opens with an "Order created" entry.
- Excel export carries the category's full spec set per line, one tab per
  category (v1.40.0). There is no PDF invoice — it was removed in v1.40.0
  because it had fallen behind the spreadsheet.

## Clients (the people we buy from)

Purchase orders had no counterparty until v1.108.0 — who we bought from
survived only as free text on `shipments.from_name`, `packages.seller_name` and
a blob in `orders.notes`, which is why payment reconciliation fuzzy-matches
strings. Now `suppliers` (**Clients** in the UI; 供货商, because 客户 is already
the sell-side customers) carries an owner, structured preferences, a contact
log and `orders.supplier_id`.

- **Standing is stored; tier, health and the follow-up date are derived** per
  read from order history — the same discipline `orders.category` and
  `total_cost` follow, because a stored status goes stale (v1.108.0).
- **Each client is judged against their own rhythm**: silent past twice the
  median gap between their POs is "gone quiet", past four times is "lost
  touch". A weekly seller quiet for three weeks is in trouble; a twice-a-year
  seller quiet for three weeks is fine (v1.108.0).
- Desktop page at `/clients`, both roles, opening on **Needs a call** rather
  than everything. No system vocabulary reaches the screen — tier A/B/C shows
  as Top seller / Regular / Occasional, health as On track / Gone quiet / Lost
  touch, a prospect as a New lead; the mapping lives in `lib/clients.ts`
  (v1.108.0).
- The **rhythm strip** draws each PO as a mark across a year, with the silence
  since the last one as a bar that goes amber past twice their own gap.
- **Logging a call is two taps and no typing**, and schedules the next one from
  the client's tier cadence — doing nothing is the correct action. A logging
  flow that costs more produces calls nobody logs, and a follow-up list that
  lies.
- Buying a shipping label **creates nothing**; sellers surface in a suggestion
  rail, which counts purchase orders rather than parcels — `shipments` is one
  row per box, so a PO shipped in three cartons is one PO, not three
  (v1.114.1).
- Attributing a PO to a client is bookkeeping, not a material edit: it is
  audited but does **not** bounce a submitted PO back to Draft. The client must
  be one of yours — a purchaser cannot attach a PO to someone else's book, and a
  client's name is scoped to the reader, so a book handed to another purchaser
  stops appearing on the previous owner's orders (v1.114.1).
- **Changing a client's owner goes through one endpoint only.** A handover has
  to leave a trace on the same timeline as the calls, so it is a reassign, never
  a field edit (v1.114.1).

## Inventory

There is **no inventory table**. Stock is `order_lines` whose PO is Done or In
Transit, and a line's qty can never be 0.

- Flat and grouped views. Grouped is what goes outward to vendors and buyers,
  so it carries no cost, sell price or submitter (v1.51.0); flat keeps them for
  internal use.
- Search matches part number, serial number, brand and id (v1.42.0).
- Export honours the row selection, one worksheet per category, with designed
  workbook styling (v1.30.0, v1.31.0). Select/unselect all lots in the current
  filter (v1.19.0).
- **The export and both screens read in the vendor bid sheet's order** — brand,
  then capacity, speed, numerically collated with blanks last (v1.107.0), and
  category rank ahead of it on the screens, which have no tabs to group by
  (v1.111.0). One implementation serves the workbooks and the lists. The screens
  still take the newest 200 rows from the database; only their arrangement
  changed.
- Other-type stock can be filtered by Untyped (v1.49.0).
- Spec fields on an inventory line are editable in place on desktop.
- **Committed sell orders reserve the units they name**, not the whole lot.

## Sell orders and the vendor portal

- A **draft sell order is a proposal**; inventory is claimed only on promotion
  (v1.41.0). Drafts can move straight to Awaiting payment (v1.13.0).
- Orders carry a payment receiver, creator-only reopen (v1.15.0) and a receiver
  column with a managers-only receiver rule (v1.16.0).
- **Negotiated final-price adjustment** with an order-summary breakdown card
  (v1.22.0, v1.23.0).
- **Vendor price round-trip**: export a bid-sheet XLSX, the vendor fills in
  prices, import it back (v1.21.0). The sheet ships pre-sorted the way the desk
  reads it, with an autofilter across the header row and no sheet protection
  (v1.51.2). Its header text is load-bearing for the import parser — don't
  move it.
- The price template splits into one worksheet per category with per-attribute
  spec columns and image URLs (v1.25.0, v1.27.0), plus per-warehouse
  packing-checklist tabs named `Pack - <warehouse>` (v1.28.0).
- **Vendor bids**: vendors reach a tokenised portal with faceted catalog
  filtering, submit bids, and managers review and promote them on a dedicated
  screen. Promotion picks and validates a customer for general links.

## Shipping

- **Shipments table and a full-page label wizard** in ShipStation's shape
  (v1.71.0), with a previous-sellers address book (v1.72.0) and a
  seller-contacts rail beside the wizard (v1.73.0).
- Prepaid labels via ShipSaving (v1.68.0, v2 client in v1.79.0).
- **External labels** can be added with carrier detection, and a delivered
  package flows into creating a PO (v1.75.0).
- **Adding a package requires its PayPal transaction ID** (v1.116.0). It is not
  paperwork: the ID carries onto the PO minted from the delivered box, and
  reconciliation auto-links a bank row to that PO on exactly this value — so a
  package added without one becomes a PO only a manager can reconcile by hand.
  Submitting without it is blocked by a dialog that names the one route a
  purchaser has, since the Payments page is manager-only: ask the manager who
  paid for the order. Dropping the payment screenshot still fills it for you.
- **Tracking is Shippo, driven by webhooks**, independent of whichever provider
  printed the label (v1.102.0). A Shippo *test* token only tracks carrier
  `shippo`.
- Mobile label scan: look up, note, create a PO; managers get a Shipping tab
  (v1.95.0).
- Owners get a default warehouse, and managers can create a package PO at any
  status (v1.85.0).

> Both shipping providers ship **dark until their keys are set** —
> `SHIPPO_API_TOKEN` / `SHIPPO_WEBHOOK_SECRET` for tracking, ShipSaving portal
> keys for labels. `/api/health` reports provider modes so this state is
> visible from outside (v1.105.0).

## Payments and reconciliation

Manager-only. Links **Mercury and PayPal transactions to purchase orders**.

- Transaction ingest with auto-pair and auto-link (v1.90.0), a background sync
  loop behind a manager-only API (v1.91.0), and a Payments page (v1.92.0).
- **Internal Mercury↔PayPal transfers are classified out of the unlinked
  queue** (v1.93.0) by counterparty and Mercury kind rules (v1.94.0).
- Unlinked transactions get **suggested matching POs** (v1.99.0).
- The queue **opens on money out**, and the Unlinked and Suggested tiles take
  the same direction lens as the rows beneath them, so the count and the list
  can never disagree (v1.114.1).
- Since v1.115.0 a company-paid PO cannot be submitted without its transaction
  ID — which is the key auto-link matches on — so those POs arrive already able
  to reconcile themselves, instead of landing in the unlinked queue for a
  manager to match by amount and date.

> PayPal's Transaction Search lags ~3 hours. A fresh transaction missing from
> Payments is usually that, not a sync bug — check `last_refreshed_datetime`
> first.

## Transfers

Internal stock movement between warehouses, with a manifest view and its own
status guard.

## Market values

Reference prices per part, readable and writable by managers, and reachable
over MCP.

- Paginated with infinite scroll (v1.12.0), sortable by clicking column headers
  (v1.67.0).
- A line can be priced while the buy can still change (v1.54.0).

## Activity and audit

- **Manager-only Activity page** unioning four ledgers — `order_events`,
  `sell_order_events`, `inventory_events`, `ref_price_events` — into one
  reverse-chronological register (v1.37.0), filterable by area, action, person,
  date range and free text. Raw kinds normalise to one vocabulary so query and
  labels can't drift.
- Loads as you scroll, with a pinned column head (v1.38.0), and "Open record"
  opens the record (v1.51.x).
- Vendor bids and member/permission changes are **absent** — they write no
  audit rows anywhere today.

## Dashboard

Per-role. Purchasers see projected profit from their own Done POs (v0.1.10);
the contributor leaderboard uses projected Done-PO profit (v1.0.1).

## Oversight extras

- **Tracker** — admin page and API proxy for the Reddit listing monitor, with a
  fleet status filter and infinite scroll (v1.64.0, v1.65.0).
- **Coordinator** — Facebook tracker page with live fleet, review stats and a
  filter prompt (v1.83.1).

## MCP and OAuth connectors

`/api/mcp` is Bearer-only and CSRF-exempt. Tools: market read/write, sellable
inventory search, sell-order draft creation.

- Connectable from both Claude and ChatGPT (v1.46.0).
- **Interactive consent lets the user choose which permissions a connector
  gets** (v1.48.0), ceilinged by role: a manager can grant any scope, everyone
  else keeps `market:read` only (v1.67.x). Manager-minted service clients are
  exempt.
- Purchasers can reach the connect page (v1.66.0).
- Per-tool gating lives in `TOOL_SCOPES` and filters both `tools/list` and
  `tools/call` — a connector missing tools has a scope problem, not a missing
  tool.
- Tool failures answer as normal results with `isError: true`, not JSON-RPC
  errors; only protocol failures are errors. Every tool ships MCP
  `annotations`, without which clients label read-only tools destructive.
- DCR is open by default, rate-limited per IP and globally.

## AI scanning and OCR

- **Label scanner for SSD lines**, gated by `categories.ai_capture` (v1.96.0),
  with high-res capture and client-side MozJPEG compression (v0.1.1).
- Mobile QR/serial scanning: a button on the serial-number field (v1.83.0),
  single-shot — capture, confirm, auto-close (v1.83.2).
- The scanner **says so when AI recognition is unavailable** and names the
  escalation (v1.97.2), and won't take a purchaser's name for a RAM brand the
  model couldn't read (v1.106.0).
- An item's specs are editable from the item itself, and a **blanked dropdown
  clears the field** — including the numeric ones, RPM and health (v1.114.1).
- Receipt auto-rename runs only on images, never spreadsheets or PDFs.

> Provider selection is silent: OpenRouter (Gemma 3 27B) when
> `OPENROUTER_API_KEY` is set, otherwise a deterministic stub. A prod deploy
> missing the key looks healthy and quietly stubs.

## The three shells

One bundle, three lazy-loaded shells chosen in `App.tsx`: a vendor token in
`/v/<token>` → `VendorApp`; viewport under 720px → `MobileApp`; else
`DesktopApp`.

- The mobile shell is a **PWA** with install onboarding, a service worker and a
  share target, scoped to mobile only (v0.1.1).
- Mobile PO lists colour-code warehouse, status and owner with stable hashed
  hues (v0.1.3).
- On mobile, the PO edit screen **docks the four category add-targets above the
  action bar** (v1.109.0), so adding a second item no longer means scrolling
  past every item already on the order — the screen reopens at the top after
  each line, which made the in-flow row recede a little further with every use.
- All strings go through `useT()`; the app ships English and Chinese.
- User preferences (theme, list-view modes) flow through `lib/preferences.tsx`
  and persist server-side.

## Observability

- Unhandled 500s write JSONL to `ERROR_LOG_DIR/errors.jsonl`, rotating at
  10 MB.
- **Client-side failures are reported** rather than lost: `ApiError` carries
  path, method and the backend's `X-Request-Id`, and `POST /api/client-errors`
  writes one greppable JSON line to stdout — capped at 5 per page load, deduped,
  and with vendor-portal tokens redacted (v1.105.0).
- `/api/health` reports version, build date, commit and provider modes.
