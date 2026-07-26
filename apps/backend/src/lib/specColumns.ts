// The one spec vocabulary every workbook download shares. Both the inventory
// export and the purchase-order spreadsheet split into per-category tabs and
// lead with that category's granular attribute columns — one per submit-form
// field, never re-merged into a single composed cell (user-confirmed
// 2026-07-23). Keeping the map here is what stops the two exports from drifting
// apart as fields are added.
import { MONEY_FMT, type XlsxColumn } from './xlsx';

export const CATEGORY_ORDER = ['RAM', 'SSD', 'HDD', 'Other'] as const;

export type SpecCategory = (typeof CATEGORY_ORDER)[number];

export const SPEC_COLS_BY_CATEGORY: Record<SpecCategory, XlsxColumn[]> = {
  RAM: [
    { header: 'Part #',      key: 'part',           width: 22 },
    { header: 'Chip #',      key: 'chip',           width: 22 },
    { header: 'Brand',       key: 'brand',          width: 14 },
    { header: 'Capacity',    key: 'capacity',       width: 10 },
    { header: 'Gen',         key: 'generation',     width: 8 },
    { header: 'Type',        key: 'type',           width: 10 },
    { header: 'Class',       key: 'classification', width: 10 },
    { header: 'Rank',        key: 'rank',           width: 8 },
    { header: 'Speed',       key: 'speed',          width: 10 },
    { header: 'Condition',   key: 'condition',      width: 12 },
  ],
  SSD: [
    { header: 'Part #',      key: 'part',           width: 22 },
    { header: 'Brand',       key: 'brand',          width: 14 },
    { header: 'Capacity',    key: 'capacity',       width: 10 },
    { header: 'Interface',   key: 'interface',      width: 12 },
    { header: 'Form factor', key: 'formFactor',     width: 12 },
    { header: 'Health %',    key: 'health',         width: 10, numFmt: '#,##0' },
    { header: 'Condition',   key: 'condition',      width: 12 },
  ],
  HDD: [
    { header: 'Part #',      key: 'part',           width: 22 },
    { header: 'Brand',       key: 'brand',          width: 14 },
    { header: 'Capacity',    key: 'capacity',       width: 10 },
    { header: 'Interface',   key: 'interface',      width: 12 },
    { header: 'Form factor', key: 'formFactor',     width: 12 },
    { header: 'RPM',         key: 'rpm',            width: 8,  numFmt: '#,##0' },
    { header: 'Health %',    key: 'health',         width: 10, numFmt: '#,##0' },
    { header: 'Condition',   key: 'condition',      width: 12 },
  ],
  Other: [
    { header: 'Part #',      key: 'part',           width: 22 },
    { header: 'Description', key: 'description',    width: 30 },
    { header: 'Condition',   key: 'condition',      width: 12 },
  ],
};

// `Item` keeps a human-scannable label next to the granular columns. `Other`
// drops it — its Description column already carries the same string.
export const ITEM_COL: XlsxColumn = { header: 'Item', key: 'item', width: 32 };

// Tab tints, so a multi-category workbook is navigable from the sheet strip
// alone. Summary tabs (Payment, totals) take the brand emerald; the categories
// take four hues far enough apart to tell at a glance.
export const SUMMARY_TAB_COLOR = 'FF0B7A62';

export const CATEGORY_TAB_COLOR: Record<SpecCategory, string> = {
  RAM: 'FF2563EB',
  SSD: 'FF7C3AED',
  HDD: 'FFD97706',
  Other: 'FF64748B',
};

// Cost columns shared by both exports, so the money block reads identically
// wherever it appears.
export const UNIT_COST_COL: XlsxColumn =
  { header: 'Unit cost', key: 'unitCost', width: 12, numFmt: MONEY_FMT };
export const SELL_PRICE_COL: XlsxColumn =
  { header: 'Sell price', key: 'sellPrice', width: 12, numFmt: MONEY_FMT };

// Fold rows into CATEGORY_ORDER buckets; an unknown category lands in Other so
// nothing can fall off the workbook.
export function groupByCategory<T extends { category?: unknown }>(
  rows: T[],
): Map<SpecCategory, T[]> {
  const byCategory = new Map<SpecCategory, T[]>();
  for (const r of rows) {
    const raw = String(r.category ?? '');
    const cat = (CATEGORY_ORDER as readonly string[]).includes(raw)
      ? (raw as SpecCategory)
      : 'Other';
    const bucket = byCategory.get(cat);
    if (bucket) bucket.push(r);
    else byCategory.set(cat, [r]);
  }
  return byCategory;
}
