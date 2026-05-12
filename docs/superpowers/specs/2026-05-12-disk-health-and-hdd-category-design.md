# Disk health + HDD category — design

**Status:** Approved (brainstorm complete, 2026-05-12)
**Scope:** Add a `health` percentage field to drive SKUs and introduce `HDD` as a sibling category to `RAM` / `SSD` / `Other`.

## Motivation

Operators grading used SSDs want to capture wear/SMART health alongside the existing brand/capacity/interface attributes. The same field applies to spinning HDDs, which the ERP has not modeled until now — HDDs were either misfiled as SSDs or as `Other`, losing the drive-specific schema.

Adding HDD as a first-class category (rather than a sub-type of SSD) matches the existing flat category picker (`RAM / SSD / HDD / Other`) and avoids forcing every consumer of `category` to branch into a sub-type discriminator.

## Data model

New migration: `apps/backend/migrations/0007_disk_health_and_hdd.sql`.

```sql
ALTER TABLE order_lines
  ADD COLUMN IF NOT EXISTS health NUMERIC(4,1)
    CHECK (health IS NULL OR (health >= 0 AND health <= 100)),
  ADD COLUMN IF NOT EXISTS rpm    SMALLINT
    CHECK (rpm IS NULL OR rpm > 0);

ALTER TABLE ref_prices
  ADD COLUMN IF NOT EXISTS health NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS rpm    SMALLINT;

INSERT INTO catalog_options ("group", value, position) VALUES
  ('HDD_BRAND',     'Seagate',   0),
  ('HDD_BRAND',     'WD',        1),
  ('HDD_BRAND',     'Toshiba',   2),
  ('HDD_BRAND',     'HGST',      3),
  ('HDD_INTERFACE', 'SATA',      0),
  ('HDD_INTERFACE', 'SAS',       1),
  ('HDD_FORM',      '2.5"',      0),
  ('HDD_FORM',      '3.5"',      1),
  ('HDD_CAP',       '500GB',     0),
  ('HDD_CAP',       '1TB',       1),
  ('HDD_CAP',       '2TB',       2),
  ('HDD_CAP',       '4TB',       3),
  ('HDD_CAP',       '8TB',       4),
  ('HDD_CAP',       '16TB',      5),
  ('HDD_RPM',       '5400',      0),
  ('HDD_RPM',       '7200',      1),
  ('HDD_RPM',       '10000',     2),
  ('HDD_RPM',       '15000',     3)
ON CONFLICT ("group", value) DO NOTHING;
```

No backfill. Existing SSD rows leave `health` NULL; no `category = 'HDD'` rows exist yet. The `orders.category` column has no CHECK constraint, so widening the application-level enum requires no DB change beyond inserts of new rows.

## Type changes

### Backend — `apps/backend/src/types.ts`
- `LineCategory = 'RAM' | 'SSD' | 'HDD' | 'Other'`
- `OrderLine` and `DraftLine` gain `health: number | null` and `rpm: number | null`.

### Frontend — `apps/frontend/src/lib/types.ts`
Parallel additions on `Category`, `OrderLine`, `DraftLine`, `RefPrice`, `DashboardData.byCat` (now keyed by all four categories), and `DashboardData.recent` (which gains `rpm`).

### Frontend — `apps/frontend/src/lib/catalog.ts`
```ts
export const HDD_BRANDS    = catalog.HDD_BRAND;
export const HDD_INTERFACE = catalog.HDD_INTERFACE;
export const HDD_FORM      = catalog.HDD_FORM;
export const HDD_CAP       = catalog.HDD_CAP;
export const HDD_RPM       = catalog.HDD_RPM;
```

## Backend route changes

| File | Change |
| --- | --- |
| `routes/orders.ts` | Add `health`, `rpm` to line SELECT lists, INSERT column lists, and the PATCH allowed-fields whitelist. Zod line schema gains `health: z.number().min(0).max(100).nullable().optional()` and `rpm: z.number().int().positive().nullable().optional()`. |
| `routes/inventory.ts` | Add the two columns to SELECT lists. |
| `routes/market.ts` | Add the two columns to ref_prices SELECT. Matching key for line → ref price is unchanged (excludes health/rpm). |
| `routes/dashboard.ts` | `byCat` aggregation groups by `category`; HDD falls in once the application enum widens. `recent` row shape gains `rpm`. |
| `routes/scan.ts` | Add `rpm` to the AI-extracted fields forwarded into the draft line. Health is never scanned. |

### AI — `apps/backend/src/ai.ts`
New stub entry and prompt for HDD:
```ts
HDD: {
  category: 'HDD',
  confidence: 0.89,
  fields: { brand: 'Seagate', capacity: '4TB', interface: 'SAS', formFactor: '3.5"', rpm: '7200', partNumber: 'ST4000NM0023' },
},
// PROMPT_BY_CATEGORY:
HDD: `You are reading an enterprise HDD label. Respond as compact JSON only:
{"brand":"…","capacity":"… TB","interface":"SATA|SAS","formFactor":"2.5\\"|3.5\\"","rpm":"5400|7200|10000|15000","partNumber":"…"}
Omit unknown fields. No prose.`
```
Health is manual-entry only — no SSD/HDD label exposes wear percentage.

## Frontend UI changes

### Submit / edit fields — `components/PhCategoryFields.tsx`
- New `if (category === 'HDD')` branch with: brand, capacity (HDD_CAP dropdown), interface (HDD_INTERFACE), formFactor (HDD_FORM), rpm (HDD_RPM dropdown), partNumber, health.
- Existing SSD branch gains a `health` field placed above `partNumber`.
- Health input: `<input type="number" min="0" max="100" step="0.1">` with a `%` suffix. Optional — blank → null.

### Category picker — `pages/desktop/DesktopSubmit.tsx`
- Add the HDD card between SSD and Other: `{ id: 'HDD', icon: 'drive', sub: t('hddSub'), tag: t('manualEntry') }`. Picker becomes RAM / SSD / HDD / Other.
- All branch points currently of the form `l.category === 'SSD' ? … : …` gain a parallel HDD case. Summary line for HDD: `${brand} ${capacity} ${rpm}rpm`. Icon stays `drive`.

### Inventory — `pages/Inventory.tsx`, `pages/desktop/DesktopInventory.tsx`, `pages/desktop/DesktopInventoryEdit.tsx`
- Filter chips widen from `['all','RAM','SSD','Other']` to `['all','RAM','SSD','HDD','Other']`.
- Row renderers (summary line, chip color, icon) get an HDD case.
- Detail/edit shows health (read-only chip on view; editable on edit) for SSD + HDD.
- A low-health indicator (`< 50%`) renders as a small inline chip on inventory rows. Threshold lives as `LOW_HEALTH_PCT = 50`.

### Market — `pages/Market.tsx`, `pages/desktop/DesktopMarket.tsx`
- Filter chips widen. HDD branch added to the row renderer for chip color and icon.

### Settings — `pages/desktop/DesktopSettings.tsx`
- New category row: `{ id: 'HDD', label: 'HDD', icon: 'drive', enabled: true, aiCapture: true, requiresPN: true, defaultMargin: 22 }`.

### Mobile — `MobileApp.tsx`
- Line summary branch adds an HDD case mirroring the desktop summary format.

### Chip tone
- RAM: existing `info` (blue) — unchanged.
- SSD: existing `pos` (green) — unchanged.
- Other: existing `warn` (orange) — unchanged.
- HDD: `accent` (purple/violet in this design system). Distinct from all three existing tones.

If during implementation `accent` reads visually too close to `warn` in the rendered palette, fall back to a new neutral-cool tone (added to `lib/status.ts` as `tone: 'cool'`) rather than reshuffling existing categories. RAM / SSD / Other chips are not reassigned.

### i18n — `lib/i18n.tsx`
New keys for both `en` and `zh`:
- `hddSub` ("SATA / SAS spinning drives" / "SATA / SAS 机械硬盘")
- `newHddOrder`, `addHddItem`, `editHddItem`
- `health` (label, "%" suffix lives next to the input not the key)
- `rpm`

Existing SSD keys are untouched.

## Seed — `apps/backend/scripts/seed.mjs`

- Add `HDD_BRANDS`, `HDD_IFACE`, `HDD_FORM`, `HDD_CAP`, `HDD_RPM` constants.
- Include `'HDD'` in the random category pick array (rebalance so each category gets a reasonable count).
- HDD branch in the line generator: brand, capacity, interface, formFactor, rpm, partNumber, plus a random `health` in 60–99 (one decimal).
- Existing SSD branch: also fill random `health` so seeded data exercises the new field everywhere.
- Add a handful of HDD rows to `ref_prices`.
- Catalog export at the bottom of the file gains `HDD_BRAND`, `HDD_INTERFACE`, `HDD_FORM`, `HDD_CAP`, `HDD_RPM` entries.

## Verification

No formal test suite exists in this repo. Verification path:

1. Run migration `0007_disk_health_and_hdd.sql`.
2. Run seed; confirm catalog_options has the new HDD groups and order_lines/ref_prices have populated health/rpm values.
3. Start the dev server. Manual flow:
   - Submit a new SSD order, set health to 87.5%, save. Confirm the value round-trips through orders list, detail, and edit.
   - Submit a new HDD order with interface + rpm + health. Confirm catalog dropdowns show HDD-specific options, not SSD's M.2 entries.
   - Inventory: filter by HDD; confirm rows render with the HDD chip and rpm in the summary; check the low-health chip appears when health < 50.
   - Market: filter by HDD; confirm HDD ref-price rows render.
   - Dashboard: confirm the byCat breakdown renders four segments with HDD's color distinct from the other three.
   - Settings: confirm the HDD category row appears alongside SSD.
4. Toggle language to zh and re-spot-check the i18n strings render correctly.

## Out of scope

- Backfilling health on historical SSD rows.
- CSV import for health/RPM.
- Bulk health editing.
- SMART-data integration or any automated health source.
- A "Disk" wrapper category that branches into SSD/HDD — explicitly chosen against during brainstorm; four flat cards instead.
