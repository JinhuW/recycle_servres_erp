# Category-specific inventory export columns — design

**Date:** 2026-07-18
**Status:** approved

## Problem

The inventory download (`GET /api/inventory/export?view=grouped`, triggered from the
desktop Inventory page) always emits one generic column set — Part #, Chip #,
Category, Item, Type, Spec, Warehouses, Qty + manager tail. Per-category
attributes are squashed into the single "Spec" string (`LRDIMM · 4Rx4 · 2400MHz`),
which is hard to sort/filter in Excel.

## Decision

Make the grouped export's leading columns depend on the active category filter:

- **Specific category (RAM / SSD / HDD / Other):** granular attribute columns,
  one per upload-form field, replacing the computed Item/Spec columns entirely.
- **"All" (no `category` param) or unknown category:** a simplified shared set —
  Part #, Category, Item, Condition.
- The manager tail (Warehouses, Qty, In stock, In transit, Reviewing, POs, Lots,
  Cost min/avg/max, Sell price, Submitted by) is unchanged in every variant.

Leading columns per category (mirrors the submit-form fields in
`LineFields.tsx` / `PhCategoryFields.tsx`):

| Category | Columns |
| --- | --- |
| RAM | Part #, Chip #, Brand, Capacity, Gen, Type, Class, Rank, Speed, Condition |
| SSD | Part #, Brand, Capacity, Interface, Form factor, Health %, Condition |
| HDD | Part #, Brand, Capacity, Interface, Form factor, RPM, Health %, Condition |
| Other | Part #, Description, Condition |

The download filename becomes `inventory-<category>-<date>.xlsx` when a known
category is filtered (e.g. `inventory-ram-2026-07-18.xlsx`), otherwise the
existing `inventory-grouped-<date>.xlsx`.

## Design notes

- Backend-only. The frontend already forwards the category filter and takes the
  filename from `Content-Disposition`.
- The grouped SQL already selects every attribute column; only the column list
  and the row-mapping object in `apps/backend/src/routes/inventory.ts` change.
  Column sets stay co-located in the route file like the existing export
  constants.
- The row mapper emits all attribute keys unconditionally; exceljs renders only
  the keys declared in the selected column list. Numeric attrs (`rpm`, `health`)
  emit `null` when absent so cells stay blank instead of showing 0.
- Condition can differ between lots in a group, so it aggregates like
  Warehouses: distinct values joined with `", "`.
- Unknown categories (future CPU/GPU) fall back to the shared column set while
  the WHERE clause still filters rows — graceful degradation with no extra code.
  `Object.hasOwn` guards prototype-key query values.
- `invLabel`/`invSpec` stay (used by the flat export and sell-order export); the
  grouped mapper just stops calling `invSpec`.

## Out of scope

- The flat (non-grouped) export variant.
- Mobile export (none exists).
- A shared category→fields registry across forms/exports (the duplication is
  noted, but consolidating it is not needed for this change).
