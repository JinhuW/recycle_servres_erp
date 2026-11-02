import { canonicalPartNumber, sellSeriesKey, type SellSeriesLine } from '@recycle-erp/shared';
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

export type SeriesFold<T> = { key: string; members: { line: T; idx: number }[] };
export type FoldedItem<T> = { line: T; idx: number } | SeriesFold<T>;

export const isFold = <T>(it: FoldedItem<T>): it is SeriesFold<T> => 'members' in it;

// One RAM series in a group — the same module, label and condition, whatever
// its die or speed — reads as one row the user unfolds, where its first line
// sat. A series of one line stays a plain row.
export function foldSeries<T extends SellSeriesLine>(items: readonly { line: T; idx: number }[]): FoldedItem<T>[] {
  const byKey = new Map<string, SeriesFold<T>>();
  for (const it of items) {
    const key = sellSeriesKey(it.line);
    if (!key) continue;
    const f = byKey.get(key);
    if (f) f.members.push(it);
    else byKey.set(key, { key, members: [it] });
  }
  const out: FoldedItem<T>[] = [];
  const placed = new Set<string>();
  for (const it of items) {
    const key = sellSeriesKey(it.line);
    const f = key ? byKey.get(key) : undefined;
    if (!f || f.members.length < 2) out.push(it);
    else if (!placed.has(f.key)) {
      placed.add(f.key);
      out.push(f);
    }
  }
  return out;
}

// A run of #s as few characters as it reads: 1, 2, 3, 5 → "1–3, 5".
export function noRange(nos: readonly number[]): string {
  const s = [...new Set(nos)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    parts.push(j > i ? `${s[i]}–${s[j]}` : String(s[i]));
    i = j;
  }
  return parts.join(', ');
}

// A group's rows as a table draws them: a fold, then its lines when it is
// open, or a plain line. A fold's entry carries its first line, so every
// entry reads the same.
export type FoldEntry<T> = { fold: SeriesFold<T> | null; line: T; idx: number; member: boolean };

export function foldEntries<T extends SellSeriesLine>(
  items: readonly { line: T; idx: number }[],
  isOpen: (fold: SeriesFold<T>) => boolean,
): FoldEntry<T>[] {
  return foldSeries(items).flatMap((it): FoldEntry<T>[] => {
    if (!isFold(it)) return [{ fold: null, ...it, member: false }];
    const head: FoldEntry<T> = { fold: it, ...it.members[0]!, member: false };
    return isOpen(it) ? [head, ...it.members.map(m => ({ fold: null, ...m, member: true }))] : [head];
  });
}
