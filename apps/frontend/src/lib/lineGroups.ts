import { CATEGORY_ORDER } from './lookups';

// Grouping the lines of a mixed purchase order by category.
//
// A PO can now hold RAM, drives and a spare part at once, and a flat list of
// forty lines gives no answer to "how much of this is memory?". Grouping
// carries a per-category subtotal, and folding a group gets a long PO out of
// the way while you work on another category.
//
// Deliberately NOT applied to a single-category PO: one group header above
// every line, restating the total the ledger already shows, is noise on the
// common case. `shouldGroup` is the gate, and both the table and the ledger
// read it so they can never disagree about whether the order is mixed.

export type GroupableLine = {
  category: string;
  qty: number | string;
  unitCost: number | string;
  sellPrice?: number | string | null;
};

export type LineGroup<T> = {
  category: string;
  lines: { line: T; index: number }[];
  units: number;
  goods: number;
  /** Profit over the group's PRICED lines only, matching the ledger's rule. */
  profit: number;
  unpriced: number;
};

const num = (v: unknown): number => Number(v) || 0;
const isPriced = (l: GroupableLine): boolean =>
  l.sellPrice != null && l.sellPrice !== '' && num(l.sellPrice) > 0;

/** True when the lines span more than one category. */
export function shouldGroup(lines: readonly GroupableLine[]): boolean {
  return new Set(lines.map(l => l.category).filter(Boolean)).size > 1;
}

/**
 * Lines bucketed by category in CATEGORY_ORDER, each carrying the index it had
 * in the flat list so callers keep their existing row handlers and numbering.
 * Categories outside the known set sort last rather than vanishing.
 */
export function groupLines<T extends GroupableLine>(lines: readonly T[]): LineGroup<T>[] {
  const buckets = new Map<string, { line: T; index: number }[]>();
  lines.forEach((line, index) => {
    const key = line.category || 'Other';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push({ line, index });
  });

  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };

  return [...buckets.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, members]) => {
      let units = 0, goods = 0, profit = 0, unpriced = 0;
      for (const { line } of members) {
        const q = num(line.qty);
        const c = num(line.unitCost);
        units += q;
        goods += q * c;
        if (isPriced(line)) profit += q * (num(line.sellPrice) - c);
        else unpriced += 1;
      }
      return { category, lines: members, units, goods, profit, unpriced };
    });
}

// CSS custom properties carrying the group's category colour, so the header
// row, its chip and its left rule all tint from one place rather than each
// re-deriving a tone map. Matches OrderCategoryChips.
const TONE: Record<string, string> = {
  RAM: 'var(--info)',
  SSD: 'var(--pos)',
  HDD: 'var(--cool, oklch(0.58 0.13 305))',
  Other: 'var(--warn)',
};
const TONE_SOFT: Record<string, string> = {
  RAM: 'var(--info-soft)',
  SSD: 'var(--pos-soft)',
  HDD: 'var(--cool-soft, oklch(0.95 0.032 305))',
  Other: 'var(--warn-soft)',
};

export const catTone = (category: string): React.CSSProperties =>
  ({
    '--cat': TONE[category] ?? 'var(--fg-subtle)',
    '--cat-soft': TONE_SOFT[category] ?? 'var(--bg-soft)',
  } as React.CSSProperties);
