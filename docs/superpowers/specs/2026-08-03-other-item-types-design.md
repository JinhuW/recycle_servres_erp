# Item types for `Other` purchase-order lines

An `Other` line is identified today by one free-text **Item description**.
Nothing classifies it, so a manager reading a PO cannot tell a CPU from a
backplane without inferring it from prose, and the prose is inconsistent
("Xeon Gold 6248", "cpu gold 6248", "6248 processor").  Nothing groups,
filters, or totals by kind of item.

This adds a required **Item type** to `Other` lines: a picker over a
workspace-wide vocabulary that anyone can extend inline.

## Decisions

| Question | Decision |
| --- | --- |
| Types per line | Exactly one — the type *is* what the item is |
| Required | Yes, same rule as Item description today |
| Who creates | Anyone, inline; managers rename/retire in Settings |
| Surfaces | Line drawer, PO line list + review, inventory list + filter, Excel exports |

Multiple tags per line were rejected: with several values there is no single
"type" column to sort, filter, or group an export by, which is the whole
point of the feature.

## Data model

Migration `0082_item_types.sql`.

```sql
CREATE TABLE item_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX item_types_name_key ON item_types (lower(name));

ALTER TABLE order_lines ADD COLUMN item_type TEXT;
CREATE INDEX order_lines_item_type_idx ON order_lines (item_type);
```

`order_lines.item_type` stores the type **name verbatim, not a foreign key**.
Every other spec field on the table (`brand`, `capacity`, `classification`)
already works this way, so the inventory queries, the PO spreadsheet, the
sell-order sheets, and the audit snapshot read it with no new joins.

The denormalization stays correct because rename is transactional: a manager
rename updates the type row and every line carrying the old name inside one
`sql.begin`.

`created_by` is `ON DELETE SET NULL` per the `0041` convention — removing a
user must not delete vocabulary the whole workspace uses.

A starter vocabulary is seeded so the picker is useful on first open: CPU, GPU,
Motherboard, PSU, Heatsink, NIC, RAID controller, Riser card, Backplane,
Chassis, Fan, Cable.

## Backend

**Read.** Active types ride along in `GET /api/lookups` as
`itemTypes: { id, name }[]`, the same boot-cache path `categories` uses.  No
per-drawer-open request.

**`POST /api/item-types`** `{ name }` — any authenticated role.  Trims,
collapses internal whitespace, rejects empty, caps at 40 characters.
Idempotent case-insensitively: creating "cpu" when "CPU" exists returns the
existing row rather than a near-duplicate.  Returns `{ id, name }`.

**`PATCH /api/item-types/:id`** `{ name?, active? }` — manager only (403
otherwise).  Rename runs in `sql.begin` and propagates to `order_lines`.
Retiring (`active: false`) removes the type from the picker but leaves lines
that already carry it untouched — historical POs must not lose their meaning.

**Line writes.** `POST /api/orders` and `PATCH /api/orders/:id` accept and
persist `itemType`, and it joins the line snapshot so a change shows up in the
activity log like any other spec edit.

**Validation.** A line with `category === 'Other'` and a blank `itemType` is a
400, mirroring the existing rule for `description`.  Pre-existing rows are
`NULL` and are only forced on next edit.

## Frontend

`Combobox` already computes an `offerCustom` branch for text matching no
option; it gains optional `onCreate` and create-row text so that branch can do
something other than accept the string verbatim.  `ItemTypePicker` wraps it:
pick from the lookups cache, or `+ Create "Riser card"` → POST → push into the
cache → select.

- `OtherFields` gains **Item type**, required, placed *above* Item
  description — broad type first, then the specific detail, matching the
  brand → capacity → … ordering every other category reads in.
- The three `hasIdentity` checks (`DesktopSubmit`, `DesktopEditOrder`,
  `MobileApp`) require both fields for `Other`.  Mobile `PhCategoryFields`
  gets the same picker.
- The type renders as a chip beside the `Other` badge in the drawer header,
  the PO items table, and mobile OrderReview / OrderDetail — replacing today's
  "Untitled item" placeholder.
- Inventory gains an `?itemType=` filter, the chip in each row, and a filter
  control when the category is `Other` or All.
- Settings › Categories gains a manager-only **Item types** panel: list with
  usage count, inline rename, retire toggle.
- All new strings go through `useT()` in both `en` and `zh`.

## Excel

`SPEC_COLS_BY_CATEGORY.Other` leads with `Type` (width 16) before
`Description`, and `lineSpecFields` maps `l.item_type ?? ''`.  This reaches
both the inventory export and the PO spreadsheet, which share the table.

## Testing

Backend integration tests:

- PO round-trip persists and returns `itemType`
- an `Other` line without a type is a 400
- `POST /api/item-types` dedupes case-insensitively
- rename propagates into `order_lines` rows
- `PATCH` as a purchaser is 403
- a retired type disappears from `/api/lookups` but survives on existing lines
- the `Other` export sheet carries the Type column

Frontend: unit coverage for the name normalize/compare helper.
