export type SellOrderLineGroupBy = 'warehouse' | 'po';

type GroupableLine = {
  warehouseId: string | null;
  warehouse: string | null;
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

// Warehouse groups keep first-seen order — the order the lines were added in.
// PO groups read like the "Packing list by PO" download: numeric PO order
// (PO-999 before PO-1442), hand-typed lines last.
export function groupSellOrderLines<T extends GroupableLine>(
  lines: readonly T[],
  by: SellOrderLineGroupBy,
): SellOrderLineGroup<T>[] {
  const map = new Map<string, SellOrderLineGroup<T>>();
  lines.forEach((line, idx) => {
    const poId = line.sourceOrderId ?? null;
    const key = by === 'po' ? (poId ?? '__none') : (line.warehouseId ?? '__none');
    let g = map.get(key);
    if (!g) {
      g = { key, warehouse: line.warehouse, poId: by === 'po' ? poId : null, items: [] };
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
