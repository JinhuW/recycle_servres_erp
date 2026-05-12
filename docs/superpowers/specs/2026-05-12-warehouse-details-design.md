# Warehouse details — design

**Date:** 2026-05-12
**Area:** Desktop Settings → Warehouses

## Problem

The Warehouses settings panel displays address, manager, timezone, receiving
cutoff, and floor area on each warehouse card, but **none of those values are
real**. They come from a hardcoded `WAREHOUSE_EXTRAS` lookup in
`apps/frontend/src/pages/desktop/DesktopSettings.tsx:1493`, keyed by the
warehouse's short code (`LA1`, `DAL`, `NJ2`, `HK`, `AMS`). Any warehouse with a
different short code shows the `WAREHOUSE_EXTRAS_DEFAULT` placeholder
(`'— address pending —'`, `'—'`, etc.). The edit modal only edits
`name`/`short`/`region`. The DB schema (`migrations/0001_init.sql:20`) only
stores those four columns.

The panel header subtitle (`X active · Y sq ft total · Z% avg capacity`) and
each card's capacity bar are computed from the same hardcoded data, so they're
also fake.

## Goal

Make the following fields real, persisted, and editable per warehouse:

- `address` (free-form, multi-line)
- `manager` (name)
- `managerPhone`
- `managerEmail`
- `timezone` (IANA, e.g. `America/Los_Angeles`)
- `cutoffLocal` (`HH:MM` in the warehouse's timezone)
- `sqft` (integer square feet)

The Active / Accepting-receipts toggles stay UI-only (out of scope).

The header subtitle and per-card capacity bar — both derived from the fake data
— are removed.

## Approach

Add columns directly to the `warehouses` table. It is a small reference table
that already lives in flat columns; a side table or JSON blob buys nothing for
a fixed, stable field set.

## Schema change

New migration `apps/backend/migrations/0007_warehouse_details.sql`:

```sql
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS address        TEXT,
  ADD COLUMN IF NOT EXISTS manager        TEXT,
  ADD COLUMN IF NOT EXISTS manager_phone  TEXT,
  ADD COLUMN IF NOT EXISTS manager_email  TEXT,
  ADD COLUMN IF NOT EXISTS timezone       TEXT,
  ADD COLUMN IF NOT EXISTS cutoff_local   TEXT,
  ADD COLUMN IF NOT EXISTS sqft           INTEGER;
```

All columns nullable. Existing rows remain valid.

Backfill in the same migration copies today's `WAREHOUSE_EXTRAS` values into
the DB so the seeded LA1/DAL/NJ2/HK/AMS warehouses don't go blank:

| short | address                                       | manager              | timezone            | cutoff_local | sqft  |
|-------|-----------------------------------------------|----------------------|---------------------|--------------|-------|
| LA1   | 2401 E. 8th St, Los Angeles, CA 90021         | Operations · West    | America/Los_Angeles | 15:00        | 14200 |
| DAL   | 6900 Ambassador Row, Dallas, TX 75247         | Operations · Central | America/Chicago     | 14:00        |  9800 |
| NJ2   | 180 Raymond Blvd, Newark, NJ 07102            | Operations · East    | America/New_York    | 16:00        | 11600 |
| HK    | Unit 12, Goodman Tsing Yi, Hong Kong          | APAC Hub             | Asia/Hong_Kong      | 17:00        |  8200 |
| AMS   | Schiphol Logistics Park, 1118 BE Amsterdam    | EMEA Hub             | Europe/Amsterdam    | 16:00        |  7400 |

`manager_phone` / `manager_email` are not in today's hardcoded data — they
stay `NULL` on backfill.

The frontend constants `WAREHOUSE_EXTRAS` and `WAREHOUSE_EXTRAS_DEFAULT` are
deleted in the frontend portion of this change (see "Frontend" below); the
DB backfill ensures the seeded warehouses don't lose their values when the
constants go away.

## Backend — `apps/backend/src/routes/warehouses.ts`

### `GET /`

Select all new columns. Return camelCase keys:

```ts
{ id, name, short, region,
  address, manager, managerPhone, managerEmail,
  timezone, cutoffLocal, sqft }
```

Ordering unchanged (`ORDER BY region, short`).

### `POST /`

Accept the new optional fields. Trim strings; treat empty string as `null`.
Validate (return 400 with a field-specific message on failure):

- `cutoffLocal` (if non-null) matches `/^([01]\d|2[0-3]):[0-5]\d$/`
- `sqft` (if non-null) is an integer `>= 0`
- `managerEmail` (if non-null) contains `@`
- `timezone` (if non-null) is non-empty (no IANA list check on the server —
  the client constrains it via a select)

Insert all columns; return the inserted row.

### `PATCH /:id`

Same validation as POST. Replace today's blanket `COALESCE(${value}, col)`
pattern with explicit per-field handling so a caller can **clear** a field by
sending `null` (or empty string, which is normalised to `null`):

- Field key omitted from the body → column unchanged
- Field key present with non-empty value → column set to that value
- Field key present with `null` or `''` → column set to `NULL`

The existing `name`/`short`/`region` rule that "empty string is invalid" still
applies to those three; only the new optional fields support clearing.

Build the UPDATE dynamically over the set of keys present in the body.

### `DELETE /:id`

Unchanged.

## Frontend types — `apps/frontend/src/lib/types.ts`

```ts
export type Warehouse = {
  id: string;
  name?: string;
  short: string;
  region: string;
  address?: string | null;
  manager?: string | null;
  managerPhone?: string | null;
  managerEmail?: string | null;
  timezone?: string | null;
  cutoffLocal?: string | null;   // 'HH:MM'
  sqft?: number | null;
};
```

## Frontend — `apps/frontend/src/pages/desktop/DesktopSettings.tsx`

### Deletions

- `WarehouseExtras` type, `WAREHOUSE_EXTRAS_DEFAULT`, `WAREHOUSE_EXTRAS`
  constants (lines 1481–1499).
- The merge that mixes hardcoded extras into rows in `reload()` (lines 1510–1515).
- `WarehouseRow` simplifies to `Warehouse & { active: boolean; receiving: boolean }`.
- The `totalSqft` / `avgCapacity` / `activeCount` computations.
- The `${activeCount} active · ${totalSqft} sq ft total · ${avgCapacity}% avg
  capacity` `sub` prop on `SettingsHeader` (line 1532). The header renders
  with title only — pass no `sub` prop. (The user's request was to remove
  the line, not replace it.)
- The `.wh-capacity` block on each card (lines 1609–1621) and any related
  `capacityPct` / `capColor` logic.

### Card body

Rows render conditionally — a field with no value (null/empty) is not
displayed, so a blank warehouse shows only name/region/short and an empty
body, with no `'—'` filler.

The "Receiving cutoff" row composes `cutoffLocal` with a short timezone
abbreviation derived from `timezone`:

```ts
function tzAbbrev(timeZone: string | null | undefined): string {
  if (!timeZone) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, timeZoneName: 'short',
    }).formatToParts(new Date());
    return parts.find(p => p.type === 'timeZoneName')?.value ?? '';
  } catch { return ''; }
}
```

Rendered as `15:00 PT` when both are set, `15:00` if no timezone.

### `WarehouseEditModal`

Draft state grows from `{name, short, region}` to include all new fields. Form
rows, in this order:

1. Name *(unchanged)*
2. Short code + Region *(unchanged row)*
3. **Address** — `<textarea rows={3}>`
4. **Manager** name — text input
5. **Manager phone** + **Manager email** — two-up row (`type="tel"` / `type="email"`)
6. **Timezone** — `<select>` populated from `Intl.supportedValuesOf('timeZone')`,
   with a fallback to a curated short list (`America/Los_Angeles`,
   `America/Denver`, `America/Chicago`, `America/New_York`,
   `Europe/Amsterdam`, `Europe/London`, `Asia/Hong_Kong`, `Asia/Tokyo`) if the
   Intl API is unavailable. Includes an empty `<option value="">(none)</option>`
   so the field can be cleared.
7. **Receiving cutoff** — `<input type="time">` bound to `cutoffLocal`.
8. **Floor area (sq ft)** — `<input type="number" min="0" step="100">`.

The save handler PATCHes (or POSTs) the full set. Empty strings are sent as
`null` so the server clears those columns. The ID display, delete confirm
block, and transfer-on-delete UI are unchanged.

## Data flow

```
Settings panel ─GET /api/warehouses─> backend ─SELECT─> Postgres
                                                (full row, camelCase)
Edit modal ─PATCH /api/warehouses/:id {fields}─> backend ─UPDATE─> Postgres
                                                (returns updated row)
Settings panel ─reload()─> refreshed list
```

No client-side cache beyond the panel's `useState`. Manager role still gated
server-side on POST/PATCH/DELETE.

## Error handling

- Server validation failures → 400 with `{ error: 'cutoffLocal must be HH:MM' }`-style messages
  → existing `api` helper throws → caught in modal `save()` → toast (`onError`).
- Network errors → same path.
- Empty values for the new optional fields are valid and clear the column.

## Testing (manual)

1. Run migration; verify the 5 seeded warehouses have backfilled
   address/manager/timezone/cutoff_local/sqft.
2. Settings → Warehouses: cards show real values, no `'— address pending —'`.
3. The `X active · Y sq ft · Z% avg capacity` subtitle is gone.
4. The per-card capacity bar is gone.
5. Create a new warehouse with just name/short/region → card has no filler
   rows; body is empty.
6. Open its editor, fill every new field, save → card updates with all rows.
7. Edit again, clear `address` and `managerPhone` → values disappear from card;
   reload confirms persistence.
8. Submit `cutoffLocal = '25:00'` → toast error, no save.
9. Submit `sqft = -5` → toast error, no save.
10. Submit `managerEmail = 'not-an-email'` → toast error, no save.
11. Non-manager user attempts to save → 403 (unchanged).

## Out of scope

- Persisting the Active / Accepting-receipts toggles (they remain local UI state).
- Filtering/sorting warehouses by country or region beyond today's behavior.
- Real capacity tracking (the bar is removed; no replacement).
- Structured address fields (street/city/state/postal/country). Free-form
  textarea is sufficient given international locations.
- Mobile parity. This change is desktop-only; the mobile app has no warehouse
  settings page.
