// The display order of the item categories, and the rank that follows from it.
//
// Both apps rank categories, and they have to rank them the same way: the
// frontend buckets a mixed PO's lines and tints the chips, the backend derives
// `orders.category`, lays out every workbook tab and picks the sell-order price
// template's sections. The literal used to be written out in five places, so
// adding a category reordered one screen and left the export behind it.

export const CATEGORY_ORDER = ['RAM', 'SSD', 'HDD', 'Other'] as const;

export type ExportCategory = (typeof CATEGORY_ORDER)[number];

/** Position in `CATEGORY_ORDER`; anything unknown ranks after the known set. */
export function categoryRank(category: string): number {
  const i = (CATEGORY_ORDER as readonly string[]).indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
}
