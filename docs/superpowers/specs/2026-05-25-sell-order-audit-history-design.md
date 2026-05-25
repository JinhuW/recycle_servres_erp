# Sell-Order Audit / Change History — Design

**Date:** 2026-05-25
**Status:** Spec
**Twin:** `services/orderAudit.ts` (PO history, already shipped)

## Problem

`sell_order_events` (migration `0050`) and `writeSellOrderEvent()` exist but
only emit `archived` / `unarchived`. Every other sell-order mutation
— creation, header edits, line changes, status transitions, status-meta
file attach/detach, status notes — is unaudited. There is also no UI to
view the events that *are* recorded.

Goal: every state-changing operation on a sell order writes an event, and
the sell-order detail page surfaces a chronological History panel.

## Non-goals

- No retroactive backfill. Events begin on deploy; pre-existing orders
  show only the `archived` / `unarchived` rows they already have.
- No mobile UI. The mobile shell does not render a sell-order detail page
  today; component is shell-agnostic and can be reused if that changes.
- No vendor-portal exposure. Vendor token routes do not need history.
- No DB-level immutability (no `REVOKE UPDATE,DELETE` on the events
  table). Considered, deferred to a follow-up if/when the audit trail is
  used for compliance, not just diagnostics.

## Architecture

Parallel the existing PO audit module (`services/orderAudit.ts`,
`routes/orders.ts`, `components/OrderActivityLog.tsx`). PO and SO
timelines stay independent — no shared event table, no cross-references.

### Event kinds

```ts
type SellOrderEventKind =
  | 'created'
  | 'status_changed'
  | 'line_added'
  | 'line_removed'
  | 'line_edited'
  | 'meta_changed'
  | 'status_meta_changed'
  | 'archived'      // already shipped
  | 'unarchived';   // already shipped
```

### Detail JSON shapes

| kind                 | detail                                                                         |
| -------------------- | ------------------------------------------------------------------------------ |
| `created`            | `{ source: 'manager' \| 'vendor_bid', vendorBidId?, status, lineCount, customerId }` |
| `status_changed`     | `{ from, to }`                                                                 |
| `meta_changed`       | `{ changes: [{ field, from, to }, ...] }`                                      |
| `line_added`         | `{ lineId, snapshot: {...minimal line fields} }`                               |
| `line_removed`       | `{ lineId, snapshot: {...} }`                                                  |
| `line_edited`        | `{ lineId, changes: [{ field, from, to }, ...] }`                              |
| `status_meta_changed`| `{ status, changes: [{ field, from, to }] }` (file attach/detach, status notes) |
| `archived`           | `{}` (unchanged)                                                               |
| `unarchived`         | `{}` (unchanged)                                                               |

### Service module

Extend `apps/backend/src/services/sellOrderAudit.ts` to mirror
`services/orderAudit.ts`:

- Export `META_FIELDS_SO` — header fields PATCH may touch on the
  `sell_orders` row. Confirmed during implementation by reading the PATCH
  handler body; expected set: `notes`, `customer_id`, `payment`,
  `commission_rate`.
- Export `LINE_FIELDS_SO` — per-line fields PATCH may update. Excludes
  ids/positions/status. Expected set: `sell_price`, `qty`, `description`,
  `condition`, plus whatever spec fields the SO route writes (confirmed
  during implementation).
- Reuse the same `diff()` helper signature and `AuditChange` type. To
  avoid duplication, lift `diff` and `AuditChange` out of
  `orderAudit.ts` into a small shared module (`services/auditDiff.ts`)
  imported by both. This refactor is in scope.

### Transactional guarantee

All writes go through `writeSellOrderEvent(tx, ...)` and run inside the
caller's `sql.begin()`. An audit row is committed only if the change it
describes is also committed — matches the existing `archived` /
`unarchived` behavior and the project tripwire on transactions.

## Wiring per mutation point

| File:line                             | Mutation                              | Event(s) to emit                                |
| ------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| `routes/sellOrders.ts:258`            | Create from manager UI                | `created` (`source: 'manager'`)                 |
| `routes/vendorBids.ts:199`            | Create from vendor-bid promotion      | `created` (`source: 'vendor_bid'`, `vendorBidId`) |
| `routes/sellOrders.ts:359`            | PATCH header + lines                  | `meta_changed` (if header diffs), plus `line_added` / `line_removed` / `line_edited` per line |
| `routes/sellOrders.ts:549`            | Status transition                     | `status_changed` (`from`, `to`)                 |
| `routes/sellOrders.ts:412`            | Status notes update                   | `status_meta_changed` (`field: 'notes'`)        |
| `routes/sellOrders.ts:422`            | Status-meta file attach               | `status_meta_changed` (`field: 'attachments_added'`) |
| `routes/sellOrders.ts:477`            | Status-meta file remove               | `status_meta_changed` (`field: 'attachments_removed'`) |
| `routes/sellOrders.ts:653-655`        | Archive / unarchive                   | `archived` / `unarchived` (unchanged)           |

### Idempotency

A PATCH that writes the same value emits no events — the `diff()` helper
returns an empty change list when JSON-stable-equal `from`/`to` values
match. A PATCH that changes nothing emits zero events. Both behaviors
are guaranteed by tests.

### Actor

`actor_id = c.var.user.id ?? null`. The column is already nullable.
System-driven creations (none currently, but reserved) would write
`null`.

## API

New endpoint, parallel to `GET /api/orders/:id/events` (orders.ts:235):

```
GET /api/sell-orders/:id/events
```

- **Auth:** owner of the SO OR `effectiveRole(u) === 'manager'`. Mirrors
  PO behavior. Anyone else → 403. Missing SO → 404.
- **Response:**
  ```ts
  {
    events: Array<{
      id: string;
      kind: SellOrderEventKind;
      detail: Record<string, unknown>;
      createdAt: string;
      actor: { id: string; name: string; initials: string } | null;
    }>;
  }
  ```
- **Ordering:** `created_at ASC, id ASC` (chronological top-to-bottom).
- **Pagination:** none. Mirrors the PO endpoint. If a single SO ever
  accumulates pathological event counts, paginate later.

## Frontend

### New component

`apps/frontend/src/components/SellOrderHistory.tsx`, adapted from
`OrderActivityLog.tsx`:

- Same icon-tone-bubble visual language; reuses `Icon`, the soft/strong
  color tokens, `fmtDate`, `relTime`, `fmtUSD`, `useT()`.
- Own `KIND_ICON` / `KIND_TONE` / `FIELD_LABEL` / `LIFECYCLE_LABEL`
  maps tuned to SO kinds and fields (`Customer`, `Sell price`, SO
  lifecycle: `Draft`, `Shipped`, `Awaiting payment`, `Done`).
- Props: `{ sellOrderId: string; refreshKey?: number }`. Parent bumps
  `refreshKey` after each successful save to force a refetch.

A single shared `<OrderActivityLog>` controlled by a `kind: 'po' | 'so'`
prop was rejected — PO and SO field/lifecycle vocabularies diverge enough
that the conditional lookup tables inside one file are harder to read
than two focused siblings. Project convention favors smaller files.

### Placement

A collapsible `<section>` at the bottom of `SellOrderDetail` (inside
`pages/desktop/DesktopSellOrders.tsx:376`), titled "History",
expanded by default. Sits below the order body so it does not compete
with primary actions but is always reachable. Matches the existing PO
detail page's "Activity" panel.

### Shells

- **Desktop:** in scope (above).
- **Mobile:** out of scope — no SO detail route exists.
- **Vendor portal:** out of scope.

## Types

Extend `apps/frontend/src/lib/types.ts`:

```ts
export type SellOrderEventKind =
  | 'created' | 'status_changed'
  | 'line_added' | 'line_removed' | 'line_edited'
  | 'meta_changed' | 'status_meta_changed'
  | 'archived' | 'unarchived';

export type SellOrderEvent = {
  id: string;
  kind: SellOrderEventKind;
  detail: Record<string, unknown>;
  createdAt: string;
  actor: { id: string; name: string; initials: string } | null;
};
```

Reuse the existing `OrderEventChange` type from PO — it's already
`{ field: string; from: unknown; to: unknown }`, which fits.

## Testing

### Backend (integration, real Postgres per project convention)

New file `apps/backend/tests/sellOrders.events.test.ts`:

1. `POST /api/sell-orders` (manager UI) → exactly one `created` event
   with `source: 'manager'`, correct `lineCount`, correct `customerId`.
2. Promoting a vendor bid that creates a SO → one `created` event with
   `source: 'vendor_bid'` and `vendorBidId` set.
3. PATCH that changes header `notes` + edits two lines + adds one line +
   removes one line → exactly one `meta_changed` (with just the `notes`
   diff) + two `line_edited` + one `line_added` + one `line_removed`,
   all in order.
4. PATCH with no actual changes → zero events.
5. PATCH that "writes" the same value to a field → zero events.
6. Status transition (`Draft → Shipped`) → one `status_changed` event
   with correct `from` / `to`.
7. Status notes update → one `status_meta_changed` event
   (`field: 'notes'`).
8. Status-meta file attach / detach → one `status_meta_changed` event
   each (`attachments_added` / `attachments_removed`).
9. Existing archive / unarchive tests still pass (regression).
10. `GET /api/sell-orders/:id/events`: 200 for manager, 200 for owner,
    403 for non-owner non-manager, 404 for missing id.

### Frontend

No new unit tests. Component is render-glue over the API; manual
verification in the browser per project convention.

## Migrations

None. The `sell_order_events` table from migration `0050` already has
the columns needed (`kind TEXT`, `detail JSONB`). New event kinds are
just additional string values — no schema change.

If a future implementer wants to enforce the closed kind set in the DB,
add a CHECK constraint in a new migration; not in scope here.

## Risks & open questions

- **`META_FIELDS_SO` / `LINE_FIELDS_SO` exact set.** Determined during
  implementation by reading `routes/sellOrders.ts:359` PATCH body.
  Spec lists the expected fields; implementer confirms before wiring.
- **Vendor-bid promotion actor.** `vendorBids.ts:199` is hit by a
  manager (the human reviewing the bid). `c.var.user` should always be
  present there; if a code path ever runs unauthenticated, `actor_id =
  null` is the fallback.
- **Large PATCH bodies.** Not clamping line event counts. A 50-line
  edit writes 50 rows; that is correct behavior and well below any
  practical limit on `sell_order_events`.
- **Customer-id changes record IDs, not names.** No PII duplication in
  `detail`. FE resolves id → name via its existing customer map at
  render time.

## Out of scope (deferred)

- DB-level append-only enforcement (revoke UPDATE/DELETE).
- Mobile and vendor-portal history views.
- Cross-order timelines (e.g. "all events for customer X").
- Event-driven webhooks / streaming.
- Backfill of `created` events for historical orders.
