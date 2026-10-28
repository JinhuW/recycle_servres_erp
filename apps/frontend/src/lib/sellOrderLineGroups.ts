import { canonicalPartNumber } from '@recycle-erp/shared';
import { lotWarehouse } from './sellOrderPack';

// 'none' is the combined view: every line in one group, in # order.
export type SellOrderLineGroupBy = 'warehouse' | 'po' | 'none';

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

// The server sends the lines in # order, numbered by product, so both
// groupings keep that order inside a group. That is the matching download's
// order too, except for a product added once the order was past Draft: it
// comes last here, with its later #, and sits in its sorted row on the sheet.
// Warehouse groups follow where the lot is
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
    const key = by === 'none' ? '__all' : by === 'po' ? (poId ?? '__none') : (warehouse ?? '__none');
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        warehouse: by === 'none' ? null : warehouse,
        poId: by === 'po' ? poId : null,
        items: [],
      };
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

// What a row shows in words: its name, the spec chips under it, the spec text
// a line without chips falls back to, and its condition.
const WORD_FIELDS = [
  'label', 'sub', 'subLabel', 'generation', 'type', 'classification', 'rank',
  'speed', 'interface', 'formFactor', 'condition',
] as const;

type SearchableLine = {
  partNumber?: string | null;
  serialNumber?: string | null;
  sourceOrderId?: string | null;
} & { [K in typeof WORD_FIELDS[number]]?: string | null };

// The order page's quick search, Pack mode's filter widened to what the row
// says: part numbers, serials and PO numbers compare canonicalised, so a label
// read with or without its dashes fits; every word typed must appear somewhere
// in the row's text. A group nothing in fits drops out; no text leaves the
// groups alone.
export function filterLineGroups<T extends SearchableLine>(
  groups: readonly SellOrderLineGroup<T>[],
  raw: string,
): SellOrderLineGroup<T>[] {
  const q = canonicalPartNumber(raw);
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  if (!q && !words.length) return [...groups];
  const fits = (l: T) => {
    if (q && [l.partNumber, l.serialNumber, l.sourceOrderId].some(v => canonicalPartNumber(v).includes(q))) return true;
    const text = WORD_FIELDS.map(f => l[f] ?? '').join(' ').toLowerCase();
    return words.length > 0 && words.every(w => text.includes(w));
  };
  return groups
    .map(g => ({ ...g, items: g.items.filter(it => fits(it.line)) }))
    .filter(g => g.items.length > 0);
}
