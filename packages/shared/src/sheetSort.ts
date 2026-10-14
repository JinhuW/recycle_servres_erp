// The order stock is read in, shared by every workbook the backend writes and
// the phone's inventory list, which pages the rows in and has to re-sort what
// it has accumulated: sorted per page, the order restarted at every page.
import { categoryRank } from './categoryOrder.js';

// Rows ship pre-sorted the way the desk reads a bid sheet (user-decided
// 2026-08-09, superseding the 2026-08-06 capacity-first order): brand, then
// capacity, speed — one brand's parts stay together on the page. Rank is
// deliberately not a key. Categories without those specs just fall through to
// the label tie-break. Every stock workbook uses this — bid tabs, packing tabs
// and the inventory export alike — so a picker, a bidder and a manager read a
// product in the same place. The bid sheet's RAM rows put a device-group /
// DDR-generation grouping ahead of it (lib/sellOrderPriceTemplate); this order
// still decides the sequence inside each group.
const SHEET_SORT_KEYS = ['brand', 'capacity', 'speed'] as const;

// Numeric collation: it keeps 8GB below
// 16GB and 3200 below 12800, which a plain lexical sort gets backwards. Blanks
// sink so manual lines (no specs at all) never head the tab. One collator for
// the module: localeCompare with options builds a fresh one per call, and the
// sell-order page sorts its lines on every read.
const SPEC_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareSpecValue(a: string, b: string): number {
  if (!a) return b ? 1 : 0;
  if (!b) return -1;
  return SPEC_COLLATOR.compare(a, b);
}

// Label breaks ties so the same data always exports byte-identically. `read`
// adapts the row shape: the bid sheet holds specs in a sub-object, the
// inventory export carries them flat on the row.
//
// `category` ranks first when given — that's the inventory *screens*, which are
// one flat table and have to earn the grouping a workbook gets free from its
// tabs. The workbook callers split by category before sorting, so they leave it
// off; don't "fix" the optionality away.
export function sortSheetRows<T>(
  rows: readonly T[],
  read: (row: T) => { specs: Record<string, unknown>; label: string; category?: string },
): T[] {
  return [...rows].sort((x, y) => {
    const a = read(x);
    const b = read(y);
    if (a.category !== undefined && b.category !== undefined) {
      const d = categoryRank(a.category) - categoryRank(b.category);
      if (d !== 0) return d;
    }
    for (const key of SHEET_SORT_KEYS) {
      const d = compareSpecValue(String(a.specs[key] ?? ''), String(b.specs[key] ?? ''));
      if (d !== 0) return d;
    }
    return compareSpecValue(a.label, b.label);
  });
}
