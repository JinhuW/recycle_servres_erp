// The order's category is derived from its lines.
//
// A PO may hold lines of several categories, so `orders.category` is no longer
// something the client sets — it is a denormalization of what the lines
// actually are: the sole category when they agree, the literal 'Mixed' when
// they don't. Keeping the column (rather than aggregating per row) is what lets
// the keyset-paginated list, the row chip and the client-side sort stay cheap.
//
// 'Mixed' matches the vocabulary `orders.status` already uses for the same
// shape. There is no FK from orders.category to the categories table, and the
// enabled-check now runs per line, so the value is never looked up there.

import { CATEGORY_ORDER } from '../lib/categoryColumns';
import type { SqlLike } from './orderAudit';

/** Category ids sorted the way every export and picker orders them. */
export function sortCategories(cats: readonly string[]): string[] {
  const rank = (c: string) => {
    const i = (CATEGORY_ORDER as readonly string[]).indexOf(c);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  return [...cats].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Deduplicates first, so callers may pass the per-line list as it stands — a
 * three-line all-RAM order derives 'RAM', not 'Mixed'.
 */
export function deriveCategory(cats: readonly string[]): string | null {
  const distinct = new Set(cats);
  if (distinct.size === 0) return null;
  return distinct.size === 1 ? [...distinct][0] : 'Mixed';
}

/**
 * Recompute `orders.category` from the order's lines. Must run inside the
 * caller's transaction so the derived value commits with the change that
 * caused it.
 *
 * A zero-line order is left alone: an empty draft has nothing to derive from,
 * and the column is NOT NULL, so overwriting it would mean inventing a value.
 */
export async function syncOrderCategory(
  tx: SqlLike,
  orderId: string,
): Promise<{ category: string | null; categories: string[] }> {
  const rows = await tx<{ category: string }[]>`
    SELECT DISTINCT category FROM order_lines WHERE order_id = ${orderId}
  `;
  const categories = sortCategories(rows.map(r => r.category).filter(Boolean));
  const category = deriveCategory(categories);
  if (category === null) return { category: null, categories };

  await tx`
    UPDATE orders SET category = ${category}
    WHERE id = ${orderId} AND category IS DISTINCT FROM ${category}
  `;
  return { category, categories };
}
