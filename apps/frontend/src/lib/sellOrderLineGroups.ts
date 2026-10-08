import { lotWarehouse } from './sellOrderPack';

export type SellOrderLineGroupBy = 'warehouse' | 'po';

type GroupableLine = {
  warehouse: string | null;
  // Where the lot is now; absent where the line's own warehouse is the answer
  // (a hand-typed line, or a backend older than this bundle).
  packWarehouse?: string | null;
  sourceOrderId?: string | null;
};

export type SellOrderLineGroup<T> = {
  key: string;
  warehouse: string | null;
  // Null for the hand-typed lines' group, which no PO backs.
  poId: string | null;
  // `idx` is the line's position in the flat input, so an editor can still
  // address its own array from inside a group.
  items: { line: T; idx: number }[];
};

// The server sends the lines in packing-list order, numbered by product, so
// both groupings keep that order inside a group: a group lists its lines the
// way the matching download does. Warehouse groups follow where the lot is
// now, as the packing lists do — not the warehouse the line was saved with,
// which a transfer leaves behind — and come in first-seen order; PO groups
// read like the "Packing list by PO" download — numeric PO order (PO-999
// before PO-1442), hand-typed lines last. A line added in edit mode sits at
// the bottom of its group until the save numbers it.
export function groupSellOrderLines<T extends GroupableLine>(
  lines: readonly T[],
  by: SellOrderLineGroupBy,
): SellOrderLineGroup<T>[] {
  const map = new Map<string, SellOrderLineGroup<T>>();
  lines.forEach((line, idx) => {
    const poId = line.sourceOrderId ?? null;
    const warehouse = lotWarehouse(line);
    const key = by === 'po' ? (poId ?? '__none') : (warehouse ?? '__none');
    let g = map.get(key);
    if (!g) {
      g = { key, warehouse, poId: by === 'po' ? poId : null, items: [] };
      map.set(key, g);
    }
    g.items.push({ line, idx });
  });
  const groups = [...map.values()];
  if (by === 'po') {
    groups.sort((a, b) => {
      if (a.poId === null) return b.poId === null ? 0 : 1;
      if (b.poId === null) return -1;
      return a.poId.localeCompare(b.poId, undefined, { numeric: true });
    });
  }
  return groups;
}
