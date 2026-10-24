// The desktop Inventory table's column sort. The server ranks every matching
// product before it caps the list at the 200 it sends, and the table re-sorts
// what it already holds the moment a header is clicked; one implementation
// keeps the two from disagreeing.

type ProductSpecs = {
  category: string; brand: string | null; capacity: string | null;
  generation: string | null; type: string | null; classification: string | null;
  rank: string | null; speed: string | null; interface: string | null;
  form_factor: string | null; description: string | null; item_type: string | null;
  rpm: number | null;
};

export type SortableProductGroup = ProductSpecs & {
  part_number: string | null;
  qty: number;
  lot_count: number;
  po_count: number;
  warehouses: string[];
  // Manager-only; a purchaser's groups never carry it, so a cost sort leaves
  // their list in workbook order instead of ranking by a figure they can't see.
  unit_cost_avg?: number;
  sell_price: number | null;
};

export function productLabel(g: ProductSpecs): string {
  // RAM surfaces type in the subtitle, so keep it out of the title to avoid
  // repeating it; other categories keep the existing label shape.
  const bits = (g.category === 'RAM'
    ? [g.brand, g.capacity, g.generation]
    : [g.brand, g.capacity, g.type, g.generation]
  ).filter(Boolean);
  return bits.length ? bits.join(' ') : (g.description || g.category);
}

export function productSpec(g: ProductSpecs): string {
  if (g.category === 'RAM') {
    return [g.type, g.classification, g.rank, g.speed ? `${g.speed} MHz` : null]
      .filter(Boolean).join(' · ');
  }
  // `Other` carries no spec columns — its item type is the whole subtitle.
  if (g.category === 'Other') return g.item_type ?? '';
  return [g.interface, g.form_factor, g.speed, g.rpm ? `${g.rpm} RPM` : null]
    .filter(Boolean).join(' · ');
}

export const INVENTORY_SORT_COLS = ['product', 'partNumber', 'qty', 'lots', 'warehouses', 'cost', 'sell'] as const;
export type InventorySortCol = typeof INVENTORY_SORT_COLS[number];

export function isInventorySortCol(v: string): v is InventorySortCol {
  return (INVENTORY_SORT_COLS as readonly string[]).includes(v);
}

// Numeric so 16GB sorts below 128GB, the way the bid sheet reads.
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortValue(col: InventorySortCol, g: SortableProductGroup): string | number | null {
  switch (col) {
    case 'product': return `${productLabel(g)} ${productSpec(g)}`;
    case 'partNumber': return g.part_number || null;
    case 'qty': return g.qty;
    case 'lots': return g.lot_count;
    case 'warehouses': return g.warehouses.length ? g.warehouses.join(', ') : null;
    case 'cost': return g.unit_cost_avg ?? null;
    case 'sell': return g.sell_price;
  }
}

// Blanks go last whichever way the column sorts. The sort is stable, so ties
// keep the order the groups came in — the workbook order, on both sides.
export function sortProductGroups<T extends SortableProductGroup>(
  groups: readonly T[], col: InventorySortCol, dir: 'asc' | 'desc',
): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const keyed = groups.map(g => ({ g, v: sortValue(col, g) }));
  keyed.sort((a, b) => {
    if (a.v === null || b.v === null) return a.v === b.v ? 0 : a.v === null ? 1 : -1;
    const d = typeof a.v === 'string' ? COLLATOR.compare(a.v, b.v as string) : a.v - (b.v as number);
    if (d !== 0 || col !== 'lots') return sign * d;
    return sign * (a.g.po_count - b.g.po_count);
  });
  return keyed.map(k => k.g);
}
