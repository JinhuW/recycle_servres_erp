# Sell-Order Spreadsheet — Per-Category Tabs + Sectioned Summary

**Date:** 2026-07-22
**Status:** Implemented

## Problem

A sell order mixes categories whose specs differ — RAM has gen/rank/speed,
SSD has interface/health. The old per-order export flattened every line into
one column set where `Type` was RAM-only and other specs were squashed into a
single `Spec` string, and detail tabs were split by warehouse, not by what
the item is.

## Decisions (user-approved)

1. **One worksheet tab per category** (RAM / SSD / HDD / Other, fixed order,
   skipped when empty). These replace the per-warehouse tabs; Warehouse is
   now a detail column. The warehouse-oriented view lives on in the
   packing-list PDF.
2. **Summary tab split into stacked per-category sections** — section title,
   category-specific header, one aggregated row per part number, bold
   per-section subtotal (Qty / Total), and a bold Order total after the last
   section.

## Semantics

- **Specs stay composed into one `Spec` field per row** (user-requested,
  2026-07-22 follow-up): `invSpec` format — RAM `RDIMM · 2Rx8 · 3200MHz`,
  SSD `SATA · 2.5in · 98%`, HDD adds rpm — next to `Item` (invLabel), rather
  than one column per attribute. The first iteration used the inventory
  grouped export's granular columns (`GROUPED_LEAD_BY_CATEGORY`); that was
  reverted same-day. Columns are now identical across tabs except `Chip #`,
  which only RAM carries.
- **Manual, non-inventory-linked lines** carry their own snapshot: `Item` =
  `label`, `Spec` = `sub_label`, granular inventory fields don't apply.
- **Aggregation is scoped per category** (key `pn:<part>` else
  `item:<label>`), which also fixes the old latent bug where same-label lines
  could merge across categories.
- **Unknown categories bucket into `Other`** so every line lands on a tab.
- **CNY orders unchanged**: native `source_unit_price` in Price/Line total,
  `Currency` column flags it. Avg price on Summary = blended Total ÷ Qty.
- **Sectioned sheets** are a new `lib/xlsx.ts` primitive
  (`XlsxSectionedSheet` / `XlsxSection`): rows are appended positionally
  (no `ws.columns`), numFmt is applied per cell, widths are the per-index max
  across sections, and there is no autoFilter/frozen header (both bind to a
  single header row, which the layout doesn't have). Plain sheets keep the
  exact previous rendering; detail tabs keep frozen bold header + autoFilter
  and therefore carry no subtotal row (it would be sorted/filtered into the
  data).

## Tests

`apps/backend/tests/sell-order-spreadsheet.test.ts` — tab layout for RAM-only
and mixed orders, Item/Spec/Chip # header shape per tab, sectioned-Summary
aggregation with subtotal/order-total rows, manual-line snapshot rendering,
CNY native prices, no-cost-columns sweep across all sheets, 403/404.
`freeSellableLine` gained an optional category filter — the export derives a
line's tab from its source inventory row, so tests pin RAM to stay
independent of seed ordering.
