# Recycle Servers ERP — Backend PRD & Test Flow

**Date:** 2026-05-11
**Author:** Product (with Claude)
**Status:** Draft — ready for backend design
**Source design:** Claude Design handoff `U-vrMyl1C2SBn2i_V0L1Sg` (Recycle Servers ERP — Desktop)
**Repository:** `/srv/data/recycle_erp` (existing Hono + Postgres + Cloudflare Worker backend)

---

## 0. How to read this document

This PRD is written **greenfield-style** (treat the design as the source of truth), but each module ends with a **GAP vs existing backend** subsection that maps the requirements onto the routes that already exist in `apps/backend/src/routes/*`. A backend engineer (human or Claude) can:

1. Read §1–§3 for the big picture.
2. For each module they own, read the relevant subsection in §4, the API contract in §5, and the gap analysis at the end of that subsection.
3. Use §6 (business rules) and §7 (non-functional) as cross-cutting constraints.
4. Use §8 (test flow) to validate the implementation end-to-end.

Anything marked **MUST** is required for v1; **SHOULD** is strongly preferred; **MAY** is optional.

---

## 1. Product vision

Recycle Servers is a small (≤30 user) used-server-parts trading business. Purchasers source RAM, SSDs and other server parts in the field; managers receive the goods, decide what to sell, and close deals with downstream customers.

The ERP supports the full cycle from "purchaser sourced parts in Shenzhen" through "manager shipped 6 lines of DDR4 to NorthBridge Data Centers and got paid." The product must:

- Let a **purchaser** submit a buy order from their phone in under 2 minutes per line — AI label capture for RAM, manual entry for SSD/Other.
- Give a **manager** a workbench to receive, review, price, and resell each line, with full audit trail.
- Track **profit and commission** per line, per purchaser, per period — including tiered commissions on realized margin.
- Surface **market intelligence**: what the team is selling each part for, what the recommended max-buy is.
- Stay usable in **English and Simplified Chinese** for the HK Ops and SG Ops teams.

The backend is a JSON API consumed by a React SPA (desktop) and a planned React Native phone app. Postgres is the source of truth. The app is hosted on Cloudflare Workers (Hono).

### Out of scope for v1
- Mobile-native code (the design includes phone-app mockups but the phone backend is the same JSON API).
- Inter-warehouse stock transfers as a first-class entity.
- Customer portal (customers do not log in).
- Inventory financial accounting export (QuickBooks/Xero integration).

---

## 2. Personas & roles

| Role | What they do | Sees | Can edit |
| --- | --- | --- | --- |
| **Purchaser** | Sources parts in the field. Submits buy orders with photos. | Own purchase orders, own inventory lines (no cost/profit for other users), Market value, Dashboard scoped to self. | Own draft orders only. After advancing to "In Transit", the manager owns the order. |
| **Manager** | Receives orders, prices items, creates sell orders, runs the team. | Everything: all orders, all inventory, all sell orders, all settings, all audit history, team dashboard. | Anything outside of completed/locked orders. Cannot delete audit-log rows. |
| **Viewer** (post-v1) | Read-only oversight. | Reports, dashboards, but not personal payout details. | Nothing. |

There is exactly one manager workspace; users belong to **teams** (e.g., `HK Ops`, `SG Ops`). Teams are descriptive — they don't gate permissions.

Demo identities (from `data.jsx`):

- `u1` Alex Chen — manager, HK Ops
- `u2` Marcus Wright — purchaser, HK Ops
- `u3` Priya Shah — purchaser, HK Ops
- `u4` Diego Ramos — purchaser, SG Ops
- `u5` Yuki Tanaka — purchaser, SG Ops
- `u6` Lina Park — purchaser, HK Ops

---

## 3. Glossary

| Term | Definition |
| --- | --- |
| **Purchase order / buy order** | What a purchaser submits — a header + 1..N line items of one category. Has an `id` like `SO-1289`. |
| **Order line / inventory line** | One row in a purchase order. The same row is the inventory record after the order ships. Has its own status (`Draft`, `In Transit`, `Reviewing`, `Done`). |
| **Sell order** | An outbound order to a customer. References inventory lines. Has `id` like `SL-4001`. |
| **Order lifecycle stage** | Manager-editable workflow stage that an *order* sits in (default 4 stages: Draft → In Transit → Reviewing → Done). Stored in `orders.lifecycle`. |
| **Line status** | Independent per-line status (same default labels). Drives sellability — only `Reviewing` lines can be added to a sell order. |
| **Sell order status** | Lifecycle of the outbound order: `Draft` → `Shipped` → `Awaiting payment` → `Done`. |
| **Reference price** | Latest sell-side market price the team is achieving for a SKU. Drives the Market value page. |
| **Commission** | Cut of realized profit paid to the submitting purchaser. Tiered by margin floor. |
| **Audit / activity log** | Append-only record of every change to an inventory line. Never edited, never deleted. |

---

## 4. Domain model

The canonical entities. Each is defined here once; APIs in §5 reference these shapes.

> Naming convention: snake_case at the DB layer, camelCase at the JSON API boundary.

### 4.1 User / member

```
users
─────
id                text PK         e.g. 'u1', or uuid for new members
email             text UNIQUE     lowercased on write
name              text
initials          text            derived from name on create
role              text            'manager' | 'purchaser' | 'viewer'
team              text NULL       'HK Ops', 'SG Ops', etc
phone             text NULL
title             text NULL
active            bool DEFAULT true
language          text DEFAULT 'en'  'en' | 'zh'
commission_rate   numeric NULL    per-user override; null = use tier table
password_hash     text            bcrypt
created_at        timestamptz DEFAULT now()
last_seen_at      timestamptz NULL
```

A `pending_invites` table tracks invitations:

```
pending_invites
───────────────
id              text PK
email           text
role            text
invited_by      text FK users.id
invited_at      timestamptz DEFAULT now()
token           text UNIQUE    accept-invite link
expires_at      timestamptz
```

### 4.2 Warehouse

```
warehouses
──────────
id            text PK     'WH-LA1'
name          text        'Los Angeles · LA1'
short         text        'LA1'  (uppercased, ≤8 chars)
region        text        'US-West' | 'US-Central' | 'US-East' | 'APAC' | 'EMEA'
```

Default seed (5 warehouses): LA1, DAL, NJ2, HK, AMS.

### 4.3 Customer

```
customers
─────────
id              text PK       'c1' or uuid
name            text
short_name      text NULL
contact         text NULL     email
region          text NULL
terms           text          'Prepay'|'Net 7'|'Net 15'|'Net 30'|'Net 60'  default 'Net 30'
credit_limit    numeric NULL
tags            text[] DEFAULT '{}'
notes           text NULL
active          bool DEFAULT true
created_at      timestamptz DEFAULT now()
```

### 4.4 Category configuration

```
categories
──────────
id                text PK       'RAM' | 'SSD' | 'Other' | 'CPU' | 'GPU' | …
label             text
icon             text
enabled           bool DEFAULT true
ai_capture        bool DEFAULT false
requires_pn       bool DEFAULT false
default_margin    numeric        target margin %, default 30
position          int            display order
```

Seeded: `RAM` (ai=true, pn=true, margin=38), `SSD` (pn=true, margin=28), `Other` (margin=22), plus disabled `CPU`/`GPU` placeholders.

### 4.5 Purchase order + line

```
orders
──────
id              text PK         'SO-1289'   (numeric suffix monotonic)
user_id         text FK users.id
category        text            'RAM'|'SSD'|'Other'   single-category per order
warehouse_id    text FK NULL
payment         text            'company' | 'self'
notes           text NULL
total_cost      numeric         either auto-sum of lines or manager override
total_cost_override  bool DEFAULT false      true iff manager set explicitly
lifecycle       text            FK→workflow_stages.id (default 'draft')
created_at      timestamptz
updated_at      timestamptz

order_lines
───────────
id              text PK         uuid or 'SO-1289-L1' style
order_id        text FK orders.id
category        text
brand           text NULL
capacity        text NULL
type            text NULL       'DDR3'|'DDR4'|'DDR5'
classification  text NULL       'UDIMM'|'RDIMM'|'LRDIMM'|'SODIMM'
rank            text NULL       '1Rx4'|'2Rx4'|...
speed           text NULL       MHz
interface       text NULL       'SATA'|'SAS'|'NVMe'|'U.2'
form_factor     text NULL       '2.5"'|'M.2 2280'|'M.2 22110'|'U.2'|'AIC'
description     text NULL       free-text for 'Other'
part_number     text NULL
chips_part_number text NULL
condition       text            'New'|'Pulled — Tested'|'Pulled — Untested'|'Used'
qty             int
unit_cost       numeric
sell_price      numeric NULL    set by manager during Reviewing
status          text            'Draft'|'In Transit'|'Reviewing'|'Done'
scan_image_id   text NULL
scan_confidence numeric NULL    0..1
position        int             ordering inside the order
created_at      timestamptz
```

### 4.6 Inventory event (audit log) — append-only

```
inventory_events
────────────────
id              bigserial PK
order_line_id   text FK order_lines.id
actor_id        text FK users.id NULL  (null = system)
kind            text     'created'|'status'|'priced'|'edited'
detail          jsonb    { field, from, to, … }
ip              inet NULL
created_at      timestamptz DEFAULT now()
```

Inserts only. **DELETE/UPDATE on this table MUST be rejected at the DB layer** (rule or `REVOKE`).

### 4.7 Sell order + line + status meta

```
sell_orders
───────────
id              text PK         'SL-4001'
customer_id     text FK customers.id
status          text            'Draft' | 'Shipped' | 'Awaiting payment' | 'Done'
terms           text            snapshot of customer.terms at create time, manager-editable
discount_pct    numeric         0..1
notes           text NULL
created_by      text FK users.id
created_at      timestamptz
updated_at      timestamptz

sell_order_lines
────────────────
id              text PK
sell_order_id   text FK sell_orders.id
inventory_id    text FK order_lines.id NULL    nullable for legacy/manual entry
category        text            snapshot
label           text            snapshot      'Samsung 32GB DDR4'
sub_label       text NULL       snapshot      'RDIMM · 3200MHz'
part_number     text NULL       snapshot
qty             int
max_qty         int             snapshot of original inventory qty (for clamp)
unit_price      numeric         editable, may differ from inventory.sell_price (list_price)
list_price      numeric         snapshot of inventory.sell_price at draft time
warehouse_id    text FK warehouses.id NULL
condition       text NULL
position        int

sell_order_status_meta
──────────────────────
sell_order_id   text FK sell_orders.id
status          text            'Shipped'|'Awaiting payment'|'Done'
note            text NULL
attachments     jsonb           [{name, size, type, storageId, url}]
recorded_at     timestamptz
recorded_by     text FK users.id
PRIMARY KEY (sell_order_id, status)
```

### 4.8 Reference price (market value)

```
ref_prices
──────────
id              text PK         'RP-5001'
category        text
brand           text NULL
capacity        text NULL
type            text NULL
classification  text NULL
speed           text NULL
interface       text NULL
form_factor     text NULL
description     text NULL
part_number     text NULL
label           text            'Samsung 32GB DDR4'
sub_label       text            'RDIMM · 3200MHz'
target          numeric         last paid by team
low_price       numeric         observed low
high_price      numeric         observed high
avg_sell        numeric         avg sell-side price
trend           numeric         decimal, e.g. -0.05 = price falling 5%
samples         int             number of data points feeding the row
source          text            'Internal — last 30d'|'Broker quotes'|'Market index'|'Supplier list'
stock           int             current units on hand for this SKU
demand          text            'high'|'medium'|'low'
history         jsonb           12-week sparkline [n1,n2,…,n12]
updated_at      timestamptz
```

Recomputed nightly by a job (out-of-scope for v1; for now seed + periodic manual recalc is fine).

### 4.9 Workflow stages

```
workflow_stages
───────────────
id            text PK       'draft'|'in_transit'|'reviewing'|'done'|custom
label         text          'Draft', '在途' (i18n is via key, not column)
short         text
tone          text          'muted'|'info'|'warn'|'pos'|'accent'|'medal'
icon          text          icon name
description   text NULL
position      int
```

### 4.10 Commission tiers

```
commission_tiers
────────────────
id              int PK
label           text          'Base'|'Tier 1'|...
floor_pct       numeric       margin floor, e.g. 25
rate            numeric       commission rate %, e.g. 4
position        int

commission_settings
───────────────────
key                       text PK    'pay_schedule'|'manager_approval'|'hold_on_returns'|'draft_mode'
value                     jsonb
updated_at                timestamptz
```

`pay_schedule` ∈ `{monthly, quarterly, on_payment}`.

### 4.11 Workspace settings (singletons)

```
workspace_settings
──────────────────
key             text PK     'workspace_name'|'domain'|'currency'|'fiscal_start'|'timezone'|'fx_auto'|'week_start'|'notify_new_order'|...
value           jsonb
updated_at      timestamptz
```

### 4.12 Notifications

```
notifications
─────────────
id              text PK
user_id         text FK users.id
kind            text         'order_submitted'|'low_margin'|'payment_received'|...
tone            text         'info'|'warn'|'pos'
icon            text
title           text
body            text NULL
unread          bool DEFAULT true
created_at      timestamptz
```

### 4.13 Files / scans

```
label_scans
───────────
id              text PK
user_id         text FK
cf_image_id     text         Cloudflare Images id
delivery_url    text
category        text
extracted       jsonb        AI-detected fields
confidence      numeric
provider        text         'cf-ai'|'stub'|...
created_at      timestamptz

attachments
───────────
id              text PK
storage_id      text         Cloudflare R2 / Images id
url             text
name            text
size            int
mime_type       text
uploaded_by     text FK users.id
created_at      timestamptz
```

Sell-order tracking files reference `attachments.id` from `sell_order_status_meta.attachments[].storageId`.

---

## 5. API surface

All routes are under `/api/`. Auth header `Authorization: Bearer <jwt>` is required except for `/api/auth/*`. Errors use HTTP status + `{"error":"message"}` body. List endpoints SHOULD support pagination via `?limit` and `?cursor`.

### 5.1 Auth

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | public | `{email, password}` → `{token, user}` |
| POST | `/api/auth/logout` | required | invalidates token (server-side denylist optional; client-side discard OK for v1) |
| GET | `/api/auth/demo-accounts` | public | list of demo users for the role picker |
| POST | `/api/auth/accept-invite` | public | `{token, password}` → activate pending invite |
| GET | `/api/me` | required | current user + lifetime stats |
| PATCH | `/api/me` | required | update language preference, phone, title |

JWT: HS256, 14-day TTL, claims `{sub, email, role, iss, iat, exp}`.

### 5.2 Members

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/members` | manager | list members + `order_count`, `lifetime_profit` |
| POST | `/api/members` | manager | create user immediately OR (preferred) create `pending_invites` row + send email |
| PATCH | `/api/members/:id` | manager | update role, team, phone, title, commission_rate, active, password |
| DELETE | `/api/members/:id` | manager | soft-delete (set `active=false`); 409 if user has orders |
| POST | `/api/members/:id/reset-password` | manager | force-reset; returns new temp password OR sends email |
| GET | `/api/members/invites` | manager | list pending invites |
| POST | `/api/members/invites/:id/resend` | manager | re-send invite email |
| DELETE | `/api/members/invites/:id` | manager | revoke invite |

Each member row carries `lastSeen` (relative time string is *derived in the UI* — return ISO timestamp).

### 5.3 Warehouses

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/warehouses` | required | list — both roles need it for filters |
| POST | `/api/warehouses` | manager | `{name, short, region}` → 201 |
| PATCH | `/api/warehouses/:id` | manager | partial update |
| DELETE | `/api/warehouses/:id` | manager | 409 if any inventory line references it |

### 5.4 Customers

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/customers?q=&status=` | manager | list with lifetime metrics |
| GET | `/api/customers/:id` | manager | one customer + order history aggregate |
| POST | `/api/customers` | manager | create. UI also allows inline create from CustomerCombobox in the sell order draft — same endpoint. |
| PATCH | `/api/customers/:id` | manager | update; set `active=false` to "archive" |

### 5.5 Categories

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/categories` | required | list enabled + disabled; UI filters in client |
| POST | `/api/categories` | manager | add a new category |
| PATCH | `/api/categories/:id` | manager | update enabled / ai_capture / requires_pn / default_margin |

Disabled categories are NOT selectable on the Submit page.

### 5.6 Workflow stages

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/workflow/stages` | required | list ordered by `position` |
| PUT | `/api/workflow/stages` | manager | replace entire list (atomic). On change, all `orders.lifecycle` values are reconciled: any value not in new set "snaps" to the nearest by old position. |
| POST | `/api/workflow/reset` | manager | restore the default 4 stages |

### 5.7 Commission

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/commission/tiers` | required | needed by purchaser dashboard to show their tier |
| PUT | `/api/commission/tiers` | manager | replace tier list |
| GET | `/api/commission/settings` | manager | pay_schedule, manager_approval, hold_on_returns, draft_mode |
| PUT | `/api/commission/settings` | manager | update settings |
| GET | `/api/commission/preview?profit=5000&margin=0.35` | manager | helper for the settings UI table |

### 5.8 Workspace / general

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/workspace` | required | name, domain, currency, fiscal_start, timezone, fx_auto, week_start, notifications |
| PATCH | `/api/workspace` | manager | partial update |
| GET | `/api/workspace/fx-rates` | required | latest FX rates (when fx_auto=true) |

### 5.9 Purchase orders

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/orders?category=&status=&scope=mine\|team&q=&limit=&cursor=` | required | manager defaults to team; purchaser forced to mine. Returns aggregated rows for the table. |
| GET | `/api/orders/:id` | required | full order + all lines |
| POST | `/api/orders` | required (purchaser owns) | create a draft order with lines. Server generates `SO-NNNN`. New orders start `lifecycle='draft'` and lines start `status='Draft'`. |
| PATCH | `/api/orders/:id` | required (owner if draft, manager otherwise) | update lifecycle, notes, total_cost_override, and any subset of lines (status, sell_price, qty, unit_cost) |
| POST | `/api/orders/:id/advance` | required | shorthand to advance `lifecycle` to next stage; convenience wrapper around PATCH. Body `{toStage?: string}` for jump. |
| DELETE | `/api/orders/:id` | manager | only when `status='Draft'` and not referenced by sell orders |
| GET | `/api/orders/:id/export.csv` | required | CSV of the order |

#### Response shape — list

```json
{
  "orders": [{
    "id": "SO-1289",
    "createdAt": "2026-04-26T10:00:00Z",
    "user": {"id":"u2","name":"Marcus Wright","initials":"MW"},
    "category": "RAM",
    "warehouse": {"id":"WH-LA1","short":"LA1","region":"US-West"},
    "payment": "company",
    "lifecycle": "reviewing",
    "stage": {"id":"reviewing","label":"Reviewing","tone":"accent","icon":"eye"},
    "lineCount": 3,
    "qty": 18,
    "revenue": 4356.00,
    "profit": 1043.50,
    "commission": 78.26,
    "totalCost": 3312.50,
    "totalCostOverride": false,
    "status": "Reviewing"      // 'Mixed' if line statuses diverge
  }],
  "nextCursor": null
}
```

### 5.10 Inventory

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/inventory?category=&status=&warehouse=&q=&limit=&cursor=` | required | flat list of `order_lines` joined to order + user + warehouse. Purchaser scoped to own. **Cost/profit fields stripped for purchaser.** |
| GET | `/api/inventory/:id` | required | one line + recent events |
| PATCH | `/api/inventory/:id` | manager (status/price), owner (cosmetic fields on Draft) | partial update — writes an `inventory_events` row per changed field |
| GET | `/api/inventory/events?scope=all\|item&itemId=&kind=&q=&limit=` | required | audit log, paginated |
| GET | `/api/inventory/aggregate/by-part?partNumber=…` | required | "QuickViewModal" — units in_transit + in_stock across part number |

### 5.11 Sell orders

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/sell-orders?status=&q=&limit=&cursor=` | manager | list with KPI counts per status |
| GET | `/api/sell-orders/:id` | manager | full sell order + lines + status_meta |
| POST | `/api/sell-orders` | manager | create draft from inventory_ids. Server clamps each line to `inventory.qty`. Each line gets a snapshot of label, sub, part_number, and an `unitPrice` defaulting to `inventory.sell_price`. |
| PATCH | `/api/sell-orders/:id` | manager | update customer, terms, notes, discount_pct; update lines (qty/unit_price/remove) |
| POST | `/api/sell-orders/:id/status` | manager | advance status. Body `{to: 'Shipped'\|'Awaiting payment'\|'Done', note?: string, attachmentIds?: string[]}`. Server inserts `sell_order_status_meta` row. **Required: `note` OR ≥1 attachment for `Shipped`, `Awaiting payment`, `Done`.** |
| DELETE | `/api/sell-orders/:id` | manager | only when status='Draft' |

#### Side effects of advancing a sell order

| New status | Effect on inventory lines in this sell order |
| --- | --- |
| `Draft` | lines go to `Reviewing`, qty is **reserved** (subtract from sellable pool) |
| `Shipped` | mark inventory lines `In Transit (outbound)` — informational only; UI uses `Reviewing` plus a "linked sell orders" badge |
| `Awaiting payment` | no inventory change |
| `Done` | inventory lines flip to `Done`; commission becomes payable (subject to commission settings) |

### 5.12 Sell-order attachments (status evidence)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/attachments` | manager | multipart `file` → returns `{id, url, name, size, mimeType}`. Files stored in Cloudflare R2 or Images. Max 10MB; PDF/PNG/JPG only. |
| GET | `/api/attachments/:id` | manager | metadata + signed URL |
| DELETE | `/api/attachments/:id` | manager | unlink + delete |

### 5.13 Market value (reference prices)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/market?category=&q=&sort=&limit=` | required | reference prices. `maxBuy` is computed server-side as `avg_sell × (1 − target_margin)` where target_margin defaults to 30% (per-category override from `categories.default_margin / 100`). |
| GET | `/api/market/:id` | required | one row + sources detail |

### 5.14 Dashboard

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/dashboard?range=7d\|30d\|90d\|ytd&category=` | required | KPIs, 8-week sparkline, contributor leaderboard, category breakdown. Purchaser scope: only their own rows. Manager: team-wide. `category` filter narrows leaderboard. |

### 5.15 Scan (AI label capture)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/scan/label` | required | multipart `file` + form field `category` ∈ `{RAM,SSD,Other}`. Returns `{imageId, deliveryUrl, extracted: {…}, confidence, provider}`. Caller then merges `extracted` into the line draft client-side. |

For `RAM` extracted fields: `brand, capacity, type, classification, rank, speed, partNumber, chipsPartNumber`.

### 5.16 Notifications

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/notifications` | required | latest 50 with unread count |
| POST | `/api/notifications/mark-read` | required | mark all read |
| POST | `/api/notifications/:id/mark-read` | required | mark one |

Notifications are produced by **server-side triggers**:
- `order_submitted` — when a purchaser advances an order to `In Transit`, notify all managers.
- `low_margin` — when a manager sets `sell_price` such that line margin < 15%, notify the manager.
- `payment_received` — when a sell order advances to `Done`, notify the submitting purchasers of the contained inventory lines (so their commission UI updates).
- `weekly_digest` — Monday 09:00 in workspace timezone, manager only.
- `capacity_alert` — when a warehouse > 85% of its capacity (capacity = stretch; ok if not in v1).

---

## 6. Business rules / invariants

### 6.1 Single-category orders
- A purchase order's `category` is set at create time and **MUST** equal the category of every line. POSTing a line with a different category → 400.

### 6.2 Purchase order lifecycle

Default stages (configurable via §5.6):

```
Draft  →  In Transit  →  Reviewing  →  Done
```

Transitions:

| From | To | Who | Side effect |
| --- | --- | --- | --- |
| Draft | In Transit | purchaser (owner) OR manager | First moment manager sees the order in their "All orders" list with non-zero KPIs. Inventory lines become visible in inventory.|
| In Transit | Reviewing | manager | Lines now sellable. |
| Reviewing | Done | manager | Lines become "stocked" / "settled". Commission calc finalizes when paired sell order closes. |
| Done | * | nobody (locked) | Edit button greyed out; PATCH returns 409 with `"order is locked"`. |
| Any non-adjacent jump | manager | manager | Allowed but logged in audit. |
| Purchaser advancing beyond `In Transit` | — | forbidden | 403. Purchaser stepper UI shows lock icons. |

A purchaser editing a `Draft` order CAN advance it to `In Transit` but cannot retreat once shipped.

### 6.3 Line status

Lines have their **own** status independent of the order lifecycle, because a manager can split-receive (some lines `Reviewing`, some still `In Transit`). The order's headline status is:

- The common line status if all lines agree.
- Literal string `"Mixed"` if they disagree.

A line is **sellable** iff `status='Reviewing'`. Selecting a non-sellable line for a sell order → 400.

A line is **locked** iff `status='Done'`. Edits → 409.

### 6.4 Sell order status

```
Draft  →  Shipped  →  Awaiting payment  →  Done
```

- `Draft` is editable; lines can be added/removed/repriced.
- Transition to `Shipped`, `Awaiting payment`, `Done` **requires** a tracking note OR ≥1 attachment (validated server-side).
- Backwards transitions are allowed for `Draft ↔ Shipped` (typo recovery). Once in `Awaiting payment` or `Done` the manager can edit the status meta (note/attachments) but cannot retreat the status.
- Legacy statuses: `Sent`, `Negotiating`, `Confirmed` → all collapse to `Draft`. `Closed` → `Done`. (Helper: see `normalizeSellOrderStatus`.)

### 6.5 Pricing & profit math

Per line:

- `revenue = qty × sell_price` (only if `sell_price` is non-null; otherwise revenue is undefined and rendered as `—`).
- `profit = qty × (sell_price − unit_cost)`.
- `margin = profit / revenue` (0 if revenue=0).
- A `sell_price < unit_cost` is permitted but the API SHOULD include `"warnings":["sub_cost_sell"]` in the response so the UI can show "⚠ Sell price below unit cost". This warning MUST also be carried in the audit event detail.

Per order:

- `total_cost` = sum of `unit_cost × qty` across lines, **unless** `total_cost_override=true` in which case the manager-entered value is canonical and the line auto-sum is shown for reference only.

### 6.6 Commission

Commission is owed to the submitter of an inventory line when that line is on a sell order that reaches `Done` (subject to `hold_on_returns` if enabled — 30-day clawback window).

For each `line`:

```
margin     = profit / revenue
applicableRate = highest tier.rate where margin*100 ≥ tier.floor_pct
commission = profit × applicableRate / 100
```

If `users.commission_rate` is non-null, that per-user rate overrides the tiered calc.

`Draft mode` (workspace setting) means: still compute and store commission rows, but don't surface them in the purchaser dashboard.

### 6.7 Audit log

- `inventory_events.kind` ∈ `{created, status, priced, edited}`.
- Every successful `PATCH /api/inventory/:id` produces 1 event per changed field.
- Every successful `POST /api/orders` produces 1 `created` event per line.
- Every line `status` change writes one `status` event with `detail = {field:"status", from:"X", to:"Y"}`.
- The table is append-only (see §4.6). The API has NO update/delete endpoints for events.
- `actor_id` is the authenticated user; for system jobs (FX, nightly recompute) it is `NULL`.

### 6.8 Role visibility

| Endpoint | Purchaser sees | Manager sees |
| --- | --- | --- |
| `/api/orders` | own orders, no other purchasers' data | all orders |
| `/api/orders/:id` | own only (403 otherwise) | any |
| `/api/inventory` | own lines, **with `unitCost`, `profit`, `margin` stripped** | all lines, full fields |
| `/api/dashboard` | own KPIs + leaderboard rank (no others' commission) | full team data |
| `/api/sell-orders` | 403 | full access |
| `/api/members` | 403 | full access |
| `/api/customers` | 403 | full access |
| `/api/commission/tiers` | read (need it to see own tier) | read + write |
| `/api/workspace`, `/api/categories`, `/api/workflow` | read | read + write |

### 6.9 i18n

- All user-facing strings on the backend (notification titles/bodies, validation messages that surface to the UI) MUST be returned as i18n keys, NOT as language-specific text. Example: `{"error_key":"validation.qty_min"}` plus a generic English `error` for fallback.
- Workspace `language` and per-user `language` are stored; UI selects translation. Backend doesn't translate; it provides keys.

### 6.10 Currency & FX

- Money columns are stored in the workspace `currency` (default USD).
- For multi-currency line-items (post-v1), each line gains a `currency` column and FX is applied at report time using the `fx_rates` table populated by the daily ECB fetch (when `fx_auto=true`).

---

## 7. Non-functional requirements

| Concern | Requirement |
| --- | --- |
| **Auth** | JWT HS256, 14-day TTL, Bearer header. Manager-only routes return 403 (not 404) on misuse. |
| **Pagination** | All list endpoints accept `?limit=` (default 50, max 200) and `?cursor=` (opaque base64). |
| **Sorting** | `?sort=col:asc|desc` on inventory, orders, sell-orders, market. Allowlist columns. |
| **Search** | `?q=` does ILIKE on key text columns (name, part_number, description). |
| **Idempotency** | POST creates that may be retried (e.g., order create from flaky mobile network) SHOULD accept `Idempotency-Key` header; same key + same body → same `id`. |
| **CORS** | Open for the SPA dev origin; allowlist in prod. |
| **Rate limiting** | 60 req/min per user; 10 req/min on `/api/scan/label` (image upload). |
| **Logging** | Structured logs with `request_id`, `user_id`, `path`, `status`, `dur_ms`. |
| **Audit** | Sensitive mutations write to `inventory_events`; member-admin actions write to a `member_events` log (out of scope for v1 detail). |
| **Background jobs** | Cron: nightly ref_price recompute, daily FX rate fetch, weekly digest, 30-day commission release. Implement as Cloudflare Cron Triggers. |
| **DB** | Postgres ≥14. All money columns `numeric(14,2)`. All timestamps `timestamptz`. All FKs ON DELETE RESTRICT unless noted. |
| **Migrations** | Forward-only numbered SQL files under `apps/backend/migrations/`. |

---

## 8. Test flow (API-level integration tests)

Run against a local instance:

```bash
pnpm db:reset          # fresh DB + seed
pnpm dev:backend       # → http://127.0.0.1:8787
```

Throughout: substitute `$TOKEN_MGR` (Alex Chen) and `$TOKEN_PUR` (Marcus Wright) after running test 1.1.

### Conventions

- Each test case lists: **Purpose · Setup · Request · Expected response · Side-effect to verify**.
- "Expected: 200" with a JSON shape skeleton — fields marked `…` may have any value, but listed fields MUST match exactly when literal values are given.
- Side effects to verify often require a follow-up `GET` and/or a SQL probe.

---

### T1. Auth & identity

**T1.1 Login as manager**
- Request: `POST /api/auth/login` body `{"email":"alex@recycleservers.io","password":"demo"}`
- Expected: 200, body `{"token":"…","user":{"id":"u1","role":"manager","language":"en",…}}`
- Save the token as `$TOKEN_MGR`.

**T1.2 Login as purchaser**
- Same shape with `marcus@…`. Save as `$TOKEN_PUR`. Verify `role: "purchaser"`.

**T1.3 Login failure**
- POST with `password:"wrong"` → 401 `{"error":"Invalid credentials"}`.

**T1.4 Demo-accounts**
- `GET /api/auth/demo-accounts` (no auth) → 200, returns ≥6 users; no password hashes leaked.

**T1.5 Missing token**
- `GET /api/me` without Authorization → 401 `Missing auth token`.

**T1.6 Invalid token**
- `GET /api/me` with `Authorization: Bearer abc.def.ghi` → 401 `Invalid auth token`.

**T1.7 Me endpoint**
- `GET /api/me` with `$TOKEN_PUR` → 200, `user.id = "u2"`, `stats.count ≥ 0`.

**T1.8 Update language**
- `PATCH /api/me` `{"language":"zh"}` with `$TOKEN_PUR` → 200. Re-GET → `user.language = "zh"`.
- Negative: `{"language":"fr"}` → 400 or silently ignored (document which); 200 with no DB change is acceptable for v1.

---

### T2. Members admin

**T2.1 Manager lists members**
- `GET /api/members` with `$TOKEN_MGR` → 200, items.length ≥ 6, each with `order_count`, `lifetime_profit`.

**T2.2 Purchaser blocked**
- `GET /api/members` with `$TOKEN_PUR` → 403 `Forbidden`.

**T2.3 Invite via create**
- `POST /api/members` `{"email":"noah.kim@recycleservers.io","name":"Noah Kim","role":"purchaser","team":"HK Ops"}` → 201 with `id`. The response MAY include a temporary password for v1.

**T2.4 Invite duplicate**
- Same POST again → 409 (unique violation on email).

**T2.5 Patch member**
- `PATCH /api/members/u3` `{"team":"SG Ops","commissionRate":7.5}` → 200. Re-GET → values updated.

**T2.6 Deactivate**
- `PATCH /api/members/u6` `{"active":false}` → 200. Try login as that user → 401.

**T2.7 Soft-delete with FK**
- `DELETE /api/members/u2` (has orders) → 409 `referenced`.

---

### T3. Warehouses & customers

**T3.1 List warehouses (both roles)**
- `GET /api/warehouses` with `$TOKEN_PUR` → 200, items.length = 5.

**T3.2 Purchaser cannot create**
- `POST /api/warehouses` `{"name":"Frankfurt · FRA","short":"FRA","region":"EMEA"}` with `$TOKEN_PUR` → 403.

**T3.3 Manager creates**
- Same POST with `$TOKEN_MGR` → 201 `{id:"WH-FRA",…}`.

**T3.4 Manager updates**
- `PATCH /api/warehouses/WH-FRA` `{"region":"EU-Central"}` → 200.

**T3.5 Delete blocked by FK**
- Create an order with `warehouseId="WH-FRA"`, then `DELETE /api/warehouses/WH-FRA` → 409.

**T3.6 Customers — list, create, inline-from-sell-order**
- `GET /api/customers?q=helios` with `$TOKEN_MGR` → 200, exactly 1 row (Helios Cloud).
- `POST /api/customers` `{"name":"New Buyer Inc.","terms":"Net 30"}` → 201.
- Verify subsequent `POST /api/sell-orders` referencing that id succeeds.

---

### T4. Submit purchase order (purchaser → manager handoff)

**T4.1 Choose category — picks RAM**
- `GET /api/categories` with `$TOKEN_PUR` → 200, RAM/SSD/Other are enabled.

**T4.2 RAM label scan**
- `POST /api/scan/label` multipart with `category=RAM` and a sample RAM-stick photo (use any small image; `STUB_OCR=true` in env to short-circuit).
- Expected: 200 `{imageId, deliveryUrl, extracted:{brand,capacity,type,…}, confidence, provider}`.

**T4.3 Submit a 3-line RAM order (Draft)**
- `POST /api/orders` with `$TOKEN_PUR`:
  ```json
  {
    "category": "RAM",
    "warehouseId": "WH-LA1",
    "payment": "company",
    "notes": "test order",
    "lines": [
      {"category":"RAM","brand":"Samsung","capacity":"32GB","type":"DDR4","classification":"RDIMM","rank":"2Rx4","speed":"3200","partNumber":"M393A4K40DB3-CWE","condition":"Pulled — Tested","qty":4,"unitCost":78.50,"scanImageId":"<from T4.2>","scanConfidence":0.94},
      {"category":"RAM","brand":"Hynix","capacity":"64GB","type":"DDR4","classification":"LRDIMM","speed":"2666","partNumber":"HMA-…","condition":"Pulled — Tested","qty":2,"unitCost":140.0},
      {"category":"RAM","brand":"Micron","capacity":"16GB","type":"DDR4","classification":"RDIMM","speed":"2666","partNumber":"MTA-…","condition":"Pulled — Tested","qty":8,"unitCost":38.0}
    ]
  }
  ```
- Expected: 201 `{"id":"SO-NNNN"}` where NNNN > 1372 (or whatever max+1 is in seed).
- Side effect: `GET /api/orders/SO-NNNN` returns lifecycle `"draft"`, all line statuses `"Draft"`. Three `inventory_events.kind='created'` rows exist for the new lines (probe with SQL or via `GET /api/inventory/events?scope=item&itemId=…`).

**T4.4 Mixed-category rejection**
- POST as T4.3 but with one SSD-shaped line in a RAM order → 400 `category mismatch`.

**T4.5 Purchaser advances to In Transit**
- `POST /api/orders/SO-NNNN/advance` (or PATCH `lifecycle="in_transit"` + all lines `status="In Transit"`) with `$TOKEN_PUR` → 200.
- Side effect: Manager `GET /api/orders?scope=team` now sees the order. A `notifications` row of kind `order_submitted` exists for `u1` (manager).

**T4.6 Purchaser cannot jump to Reviewing**
- Repeat advance from `In Transit` → `Reviewing` with `$TOKEN_PUR` → 403.

**T4.7 Manager advances to Reviewing**
- `POST /api/orders/SO-NNNN/advance` with `$TOKEN_MGR` → 200. Lines move to `Reviewing` (now sellable).

**T4.8 Manager prices each line**
- `PATCH /api/orders/SO-NNNN` body `{"lines":[{"id":"<L1>","sellPrice":120.0},{"id":"<L2>","sellPrice":175.0},{"id":"<L3>","sellPrice":55.0}]}` → 200.
- Side effect: 3 `inventory_events.kind='priced'` rows.

**T4.9 Low-margin warning surfaces**
- PATCH one line with `sellPrice=39.0` against a `unit_cost=38.0` (margin ≈ 2.6%).
- Expected: 200 with `"warnings":["low_margin"]` in response. Notifications row of kind `low_margin` created.

**T4.10 Sell price below cost permitted with warning**
- PATCH `{"lines":[{"id":"<L3>","sellPrice":30.0}]}` (cost was 38.0) → 200 with `"warnings":["sub_cost_sell"]`.

**T4.11 Manager closes the order**
- Advance to `Done` → 200. All line statuses = `Done`. Subsequent PATCH → 409 `order is locked`.

---

### T5. Inventory (manager and purchaser views)

**T5.1 Manager team-wide list**
- `GET /api/inventory?status=Reviewing` → 200, items include lines from multiple users. Each item has full fields (`unitCost`, `profit`, `margin`).

**T5.2 Purchaser scoped view**
- Same request with `$TOKEN_PUR` → 200, items only from `user_id="u2"`. `unitCost`, `profit`, `margin` are NOT in the response.

**T5.3 Filter by warehouse**
- `GET /api/inventory?warehouse=WH-LA1` → 200, every item's `warehouse.id` = WH-LA1.

**T5.4 Search**
- `GET /api/inventory?q=samsung` → 200, every item matches Samsung in brand/PN/desc.

**T5.5 Single-item detail**
- `GET /api/inventory/<lineId>` → 200, item + events (≥1 event, the creation).

**T5.6 Manager edits qty/condition; audit grows**
- `PATCH /api/inventory/<lineId>` `{"qty":3,"condition":"Used"}` → 200. Re-GET → 3 new `edited` events (one per changed field, depending on impl). Verify `from`/`to` payload.

**T5.7 Purchaser cannot edit price/status**
- `PATCH /api/inventory/<own-line-id>` with `$TOKEN_PUR` `{"status":"Done"}` → 403.
- Same with `{"sellPrice":99}` → 403.
- Same with `{"condition":"Used"}` on a `Draft` line they own → 200.

**T5.8 QuickView aggregate**
- `GET /api/inventory/aggregate/by-part?partNumber=M393A4K40DB3-CWE` → 200 `{partNumber, inTransit:N1, inStock:N2, lines:N3}`.

**T5.9 Activity log filters**
- `GET /api/inventory/events?kind=priced&limit=20` → 200, every event has `kind="priced"`.
- `GET /api/inventory/events?scope=item&itemId=<lineId>` → 200, events restricted to that line.

**T5.10 Audit log is append-only**
- Attempt `DELETE /api/inventory/events/<eventId>` → 404 (route does not exist) OR 405. Either is acceptable; route MUST NOT delete.

---

### T6. Sell orders

**T6.1 Purchaser blocked**
- `GET /api/sell-orders` with `$TOKEN_PUR` → 403.

**T6.2 Create draft from selected inventory**
- Pre-condition: 6 inventory lines in `Reviewing` status with `sell_price` set.
- `POST /api/sell-orders`:
  ```json
  {
    "customerId":"c1",
    "discountPct":0.04,
    "notes":"first batch",
    "lines":[
      {"inventoryId":"<L1>","category":"RAM","label":"Samsung 32GB DDR4","subLabel":"RDIMM · 3200MHz","partNumber":"M393A4K40DB3-CWE","qty":4,"unitPrice":120.0,"warehouseId":"WH-LA1","condition":"Pulled — Tested"},
      …
    ]
  }
  ```
- Expected: 201 `{"id":"SL-NNNN"}`. Lines snapshot their labels.

**T6.3 Non-sellable line rejected**
- POST with one inventoryId whose line is `Draft` → 400 `not sellable`.

**T6.4 Reduce qty within max**
- `PATCH /api/sell-orders/SL-NNNN` `{"lines":[{"id":"<sol1>","qty":2}]}` → 200.

**T6.5 Over-qty rejected**
- Same PATCH with `qty: 99` (greater than `max_qty`) → 400 `qty exceeds available`.

**T6.6 Unit price edited; warn vs list_price**
- PATCH `{"lines":[{"id":"<sol1>","unitPrice":100.0}]}` (list was 120) → 200, response `warnings:["price_below_list"]`.

**T6.7 Advance to Shipped — note required**
- `POST /api/sell-orders/SL-NNNN/status` `{"to":"Shipped"}` → 400 `note or attachments required`.
- Same with `{"to":"Shipped","note":"FedEx 7732…"}` → 200. `sell_order_status_meta` row exists with that note.

**T6.8 Advance with attachments**
- `POST /api/attachments` (multipart, small PDF) → 200 `{id}`.
- `POST /api/sell-orders/SL-NNNN/status` `{"to":"Awaiting payment","note":"Invoice INV-7","attachmentIds":["<id>"]}` → 200.

**T6.9 Advance to Done; inventory lines locked**
- `POST .../status` `{"to":"Done","note":"Paid 2026-05-09 wire #X"}` → 200.
- Verify each underlying inventory line is now `status="Done"`.
- Verify commission row(s) exist (or commission column populated, depending on storage choice).

**T6.10 Locked sell order**
- `PATCH /api/sell-orders/SL-NNNN` after Done → 409.

**T6.11 Customer combobox path: inline create**
- `POST /api/customers` `{"name":"InlineBuyer Ltd","terms":"Net 30"}` → 201 `{id}`.
- `POST /api/sell-orders` using that id → 201.

---

### T7. Market value

**T7.1 Default list**
- `GET /api/market` → 200, ≥30 rows, each with `maxBuy = round(avgSell * 0.7, 2)` (default target_margin 30%).

**T7.2 Category filter**
- `GET /api/market?category=RAM` → all items category=RAM.

**T7.3 Search**
- `GET /api/market?q=hynix` → only Hynix items.

**T7.4 Sort by trend ascending (falling fastest)**
- `GET /api/market?sort=trend:asc` → items ordered by trend ASC.

---

### T8. Dashboard

**T8.1 Manager team view**
- `GET /api/dashboard?range=30d` with `$TOKEN_MGR` → 200, `role:"manager"`, `kpis.revenue > 0`, `weeks.length=8`, `leaderboard` has all purchasers.

**T8.2 Purchaser scoped view**
- Same with `$TOKEN_PUR` → 200, `kpis.revenue` reflects only u2's lines. `leaderboard` still returned for ranking context but with no other purchasers' commission visible? — Decision: include profit/revenue, but NOT commission, for non-self users in the leaderboard. Verify `leaderboard.find(r => r.id !== "u2").commission === undefined` or `null`.

**T8.3 Category filter**
- `GET /api/dashboard?range=30d&category=RAM` → leaderboard re-ranked by RAM profit only.

---

### T9. Workflow stages

**T9.1 List default**
- `GET /api/workflow/stages` → 4 stages in order: draft, in_transit, reviewing, done.

**T9.2 Reorder + rename via PUT**
- `PUT /api/workflow/stages` body `{"stages":[{id:"draft",label:"Sourcing",short:"Src",tone:"muted",icon:"edit"},{id:"in_transit",label:"Shipping",short:"Ship",tone:"info",icon:"truck"},{id:"reviewing",label:"QC",short:"QC",tone:"accent",icon:"eye"},{id:"done",label:"Closed",short:"Closed",tone:"pos",icon:"check"}]}` → 200.
- Re-GET → labels updated.

**T9.3 Add a custom stage**
- PUT with an extra `{id:"qc_hold", label:"QC Hold", short:"Hold", tone:"warn", icon:"alert"}` between reviewing and done → 200. Existing orders with `lifecycle='reviewing'` remain; new orders can move through 5 stages.

**T9.4 Reset to default**
- `POST /api/workflow/reset` → 200. Stage list returns to defaults; existing custom-lifecycle orders snap to the nearest.

**T9.5 Purchaser cannot edit**
- PUT with `$TOKEN_PUR` → 403.

---

### T10. Commission rules

**T10.1 Read tiers**
- `GET /api/commission/tiers` → 4 tiers (Base 0/2, Tier 1 25/4, Tier 2 35/6, Top 45/9).

**T10.2 Update tiers**
- `PUT /api/commission/tiers` with new rate values → 200.

**T10.3 Preview helper**
- `GET /api/commission/preview?profit=5000&margin=0.35` → `{tier:"Tier 2", rate:6, payable:300}`.

**T10.4 End-to-end: commission flows to dashboard**
- Submit an order, price it for 35% margin, ship + close a sell order containing the lines, then `GET /api/dashboard` → the submitting purchaser's `kpis.commission` reflects 6% of profit (matching Tier 2).

---

### T11. Notifications

**T11.1 New order triggers notification**
- After T4.5 (purchaser advanced to In Transit), `GET /api/notifications` with `$TOKEN_MGR` → at least one item `kind: "order_submitted"`.

**T11.2 Mark read**
- `POST /api/notifications/mark-read` → 200. Re-GET → `unreadCount: 0`.

---

### T12. Settings — workspace

**T12.1 Defaults**
- `GET /api/workspace` → `currency:"USD", fiscalStart:"January", timezone:"America/Los_Angeles", fxAuto:true, weekStart:"Monday"`.

**T12.2 Update currency**
- `PATCH /api/workspace` `{"currency":"HKD"}` → 200. Re-GET reflects.

**T12.3 Purchaser blocked**
- PATCH with `$TOKEN_PUR` → 403.

---

### T13. Negative & cross-cutting

**T13.1 Rate limit (smoke)**
- 70 rapid `GET /api/dashboard` calls within a minute → 60-ish 200s and remainder 429.

**T13.2 Idempotency**
- POST T4.3 with header `Idempotency-Key: e2e-abc` twice → same `id` returned both times, only one DB row.

**T13.3 Pagination**
- `GET /api/orders?limit=2` → 2 items + `nextCursor`. Re-GET with `?cursor=<value>` → next 2.

**T13.4 Sort allowlist**
- `GET /api/orders?sort=password_hash:asc` → 400 `sort column not allowed`.

**T13.5 SQL injection probe**
- `GET /api/customers?q=%27;%20DROP%20TABLE%20customers;--` → 200 with empty list; DB intact.

---

### T14. Test runner & fixtures (recommended)

- Use **Node test runner** (`node --test`) or **vitest** with `undici` for HTTP.
- A `tests/fixtures/sample.png` and `sample.pdf` for the scan/attachment tests.
- Provide a `pnpm test:e2e` script that:
  1. Starts the worker in test mode (in-memory or test DB).
  2. Runs `pnpm db:reset` (or a snapshot of seed data).
  3. Runs the suite.
  4. Tears down.
- Tests SHOULD be order-independent where possible; the few that are ordered (T4 sequence, T6.7→T6.9) should live in one test file.

---

## 9. Gap analysis — existing backend vs design

The repo already has a working Hono backend. This section maps the PRD against what's actually implemented as of 2026-05-11.

| Module | Existing | Status vs design |
| --- | --- | --- |
| Auth | `routes/auth.ts` (login, demo-accounts), `auth.ts` (JWT 14d, bcrypt) | **OK**. Missing: `/api/auth/logout`, `/api/auth/accept-invite`. |
| Me | `routes/me.ts` (GET, PATCH language) | **OK**. Stats are computed; matches spec. Missing phone/title PATCH. |
| Members | `routes/members.ts` (list, create, patch incl. password) | **Partial**. Missing: invites table, `/invites` routes, `/reset-password`, `DELETE`. |
| Warehouses | `routes/warehouses.ts` (full CRUD) | **OK**. |
| Customers | `routes/customers.ts` (list, create, patch — no DELETE) | **OK** modulo soft-delete UX. Add `GET /:id` for the customer detail panel. |
| Categories | — | **MISSING**. Need `categories` table + routes. Currently RAM/SSD/Other are hardcoded enums in `types.ts`. |
| Workflow | `routes/workflow.ts` (GET, PUT) | **OK**. Missing `POST /reset`. |
| Commission | — | **MISSING**. No `commission_tiers` table or routes; dashboard hardcodes `* 0.075`. |
| Workspace settings | — | **MISSING**. No `workspace_settings` storage; UI uses local state only. |
| Orders | `routes/orders.ts` (list, get, create, patch) | **Partial**. Issues: (a) POST hard-codes `lifecycle='awaiting_payment'` (wrong — should be `draft`); (b) hard-codes line `status='In Transit'` (should be `Draft`); (c) no `/advance` shorthand; (d) no DELETE; (e) no CSV export; (f) no idempotency. |
| Inventory | `routes/inventory.ts` (list, get, patch + events) | **Mostly OK**. Issues: (a) **purchaser sees `unit_cost` in `/api/inventory` response** — should be stripped; (b) no aggregate-by-part endpoint; (c) needs role-based field filtering. |
| Sell orders | `routes/sellOrders.ts` (list, get, create, patch) | **Partial**. Missing: (a) `POST /:id/status` with required note/attachments; (b) `sell_order_status_meta` table; (c) attachment plumbing; (d) qty clamp validation; (e) inventory line state transitions when status advances. |
| Sell-order status meta | — | **MISSING**. New table + endpoints required. |
| Attachments | `images.ts` exists for Cloudflare Images (scan upload). | **Partial**. Need generic `/api/attachments` endpoints separate from `/api/scan/label`. |
| Market | `routes/market.ts` (list with computed maxBuy) | **OK** for list. Missing `GET /:id` for source detail. Background recompute job is out of v1 scope. |
| Dashboard | `routes/dashboard.ts` (kpis, weeks, leaderboard, byCat, recent) | **OK** structurally. Issue: hard-coded `* 0.075` commission rate — must pull from tier table once §6.6 is implemented. Range param `?range=` not honored (always 30d). |
| Scan | `routes/scan.ts` (multipart, AI OCR, persists `label_scans`) | **OK**. |
| Notifications | `routes/notifications.ts` (list + mark-read) | **Partial**. No trigger sources — notifications are seeded, not produced by domain events. Need server-side triggers for `order_submitted`, `low_margin`, `payment_received`. No per-item mark-read endpoint. |
| i18n | `users.language` column exists | **OK** for storage. Error messages currently English-only; should return keys (§6.9). |
| Audit (`inventory_events`) | Append-only by convention, but no DB-level lock | **Partial**. Add `REVOKE UPDATE, DELETE ON inventory_events FROM CURRENT_USER` or a rule. |
| Background jobs | none | **MISSING**. Cron triggers for FX, weekly digest, commission release. Defer if needed for v1. |
| Pagination | none on most lists | **MISSING**. Add `?limit=`/`?cursor=`. |
| Idempotency | none | **MISSING** (low priority, mobile-only concern). |

**Priority list for the backend engineer:**
1. Fix `orders` POST defaults (`lifecycle='draft'`, line `status='Draft'`).
2. Add categories table + routes (unblocks Submit page when CPU/GPU come online).
3. Add sell-order status meta + attachments + note/attachment requirement.
4. Strip cost/profit from inventory payload for purchasers.
5. Wire commission tiers (replace hardcoded 0.075).
6. Workspace settings store + routes.
7. Server-side notification triggers (`order_submitted`, `low_margin`).
8. Pagination + sort allowlists.

---

## 10. Open questions / decisions to make before/during implementation

1. **Idempotency-Key**: hash body or trust the key as opaque? Recommend hash(body) to prevent collisions on careless retries.
2. **Commission storage**: per-event row (one per line per close) or computed-on-read? Per-row is auditable; computed-on-read simpler. The dashboard's `commission` is currently computed at read time — keep that for v1 and store snapshot rows once `Done` happens, so payout cycles are reproducible.
3. **Attachment storage**: Cloudflare R2 (general blobs) vs Cloudflare Images (images only)? Recommend R2 for PDFs/invoices and reuse Images for label scans. Schema: `attachments.storage_id` is opaque; per-source plumbing lives in `images.ts` / `r2.ts`.
4. **Inventory aggregate**: cache the by-part totals or compute on read? Compute on read for v1; index on `(part_number, status)` to keep it cheap.
5. **Cron triggers**: implement as separate Cloudflare Worker or in-process? Recommend separate `scheduled` handlers in the same Worker (Cloudflare Cron Triggers).
6. **Soft-delete vs hard-delete**: customers and members → soft (active=false). Warehouses → hard delete blocked by FK is fine.
7. **Language fallback**: if a user has `language='zh'` but a notification key has no Chinese translation, fall back to English. Decided.

---

## 11. Out-of-scope reminder

- Inter-warehouse transfers, returns/RMA, customer self-service portal, multi-currency line items, accounting integrations, native mobile auth (OTP / push), real-time websockets (notifications are polled).

---

*End of PRD.*
