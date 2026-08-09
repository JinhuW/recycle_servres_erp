import { categoryRank, isPricedSellPrice } from '@recycle-erp/shared';
import { categoryTone } from './lookups';

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
const isPriced = (l: GroupableLine): boolean => isPricedSellPrice(l.sellPrice);

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

  return [...buckets.entries()]
    .sort(([a], [b]) => categoryRank(a) - categoryRank(b) || a.localeCompare(b))
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

export type PricedTotals = {
  /** Σ qty × sellPrice over the priced lines. */
  revenue: number;
  /** Σ qty × unitCost over the priced lines only — NOT the PO's goods total. */
  cost: number;
  profit: number;
  count: number;
};

/**
 * The projected return, over the lines that carry a sell price.
 *
 * The same rule as a group's `profit`, rolled up across every category: an
 * unpriced line contributes nothing rather than being scored as a total loss.
 * Both desktop PO screens feed the cost tape from this, so "3 of 5 priced"
 * can't mean one thing on capture and another on edit.
 */
export function pricedTotals(lines: readonly GroupableLine[]): PricedTotals {
  let revenue = 0, cost = 0, count = 0;
  for (const line of lines) {
    if (!isPriced(line)) continue;
    const q = num(line.qty);
    revenue += q * num(line.sellPrice);
    cost += q * num(line.unitCost);
    count += 1;
  }
  return { revenue, cost, profit: revenue - cost, count };
}

export type DisplayRow<T> = {
  line: T;
  index: number;
  /** Category whose header this row must be preceded by, or null for none. */
  head: string | null;
  /** Folded away: the table renders `head` if present and skips the row. */
  hidden: boolean;
};

/**
 * The order the items table walks, so grouped rows come out contiguous
 * (position order interleaves categories) while every row keeps the index its
 * handlers were written against.
 *
 * `hidden` is gated on `grouped`, not on `folded` alone. Fold state outlives
 * the headers that toggle it: fold RAM on a RAM+SSD PO, then delete the SSD
 * line, and the order is no longer mixed — no header is emitted for anything,
 * so a row hidden on fold state alone would sit behind a toggle that is not on
 * the screen any more, with no way back short of a reload.
 */
export function displayRows<T extends GroupableLine>(
  lines: readonly T[],
  groups: readonly LineGroup<T>[],
  grouped: boolean,
  folded: ReadonlySet<string>,
): DisplayRow<T>[] {
  if (!grouped) return lines.map((line, index) => ({ line, index, head: null, hidden: false }));
  return groups.flatMap(g => g.lines.map(({ line, index }, k) => ({
    line,
    index,
    head: k === 0 ? g.category : null,
    hidden: folded.has(g.category),
  })));
}

// CSS custom properties carrying the group's category colour, so the header
// row, its chip and its left rule all tint from one place. `--cat-strong` is
// the variant anything that sets TEXT in the category colour must use — `--cat`
// is a fill and does not carry a readable label on `--cat-soft`.
export const catTone = (category: string): React.CSSProperties => {
  const { tone, soft, strong } = categoryTone(category);
  return { '--cat': tone, '--cat-soft': soft, '--cat-strong': strong } as React.CSSProperties;
};
