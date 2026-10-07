import { canonicalPartNumber } from '@recycle-erp/shared';
import {
  isAbsentChecked, isShortChecked, lineState, matchScan,
  type CheckableLine, type LineCheck, type ScanMatch,
} from './boxCheck';

// Pack mode: a manager ticking a sell order's lines into the box. The count
// and tick rules are Review mode's (lib/boxCheck.ts), applied to sell lines;
// this adds what packing needs on top — the line's # on the order, which the
// packer labels each item with, where each lot sits, and which line a scan
// meant. Pure — the page owns the state.

export type PackLine = CheckableLine & {
  warehouseId: string | null;
  warehouse: string | null;
  // Where the lot is now, which packing goes by. Absent from a backend older
  // than this bundle.
  packWarehouse?: string | null;
  sourceOrderId?: string | null;
  sourceLineNo?: number | null;
};

export type PackRow = { lineId: string; counted: number; packedAt: string | null; serialNumber: string | null };
export type PackResponse = { lines: PackRow[] };

export function toCheck(r: PackRow): LineCheck {
  return { lineId: r.lineId, counted: r.counted, checkedAt: r.packedAt };
}

export function packBody(c: LineCheck, qty: number): { counted: number; packed: boolean } {
  return { counted: Math.min(c.counted, qty), packed: c.checkedAt !== null };
}

// The backend's own name for lines with no warehouse, on the packing-list tabs.
export const UNASSIGNED = 'Unassigned';

export function packWarehouseOf(l: Pick<PackLine, 'warehouse' | 'packWarehouse'>): string {
  return (l.packWarehouse === undefined ? l.warehouse : l.packWarehouse) ?? UNASSIGNED;
}

// The warehouses an order is packed from, as the packing-list downloads split
// them: alphabetical, lines with no warehouse last.
export function packWarehouseOptions(lines: readonly Pick<PackLine, 'warehouse' | 'packWarehouse'>[]): string[] {
  return [...new Set(lines.map(packWarehouseOf))].sort((a, b) => {
    if (a === UNASSIGNED) return 1;
    if (b === UNASSIGNED) return -1;
    return a.localeCompare(b);
  });
}

// A line held at 0 stays on the order to keep its #, but has nothing to pack.
export const isPackable = (l: Pick<CheckableLine, 'qty'>): boolean => l.qty > 0;

export type PackRowView<L> = { line: L; no: number };

// Every line in the order's own list order with its # (1-based, counted over
// the whole order so a warehouse filter doesn't renumber). A ticked line stays
// where it is: the packer and the receiver both read the list by #.
// `wh` '' means every warehouse.
export function packView<L extends PackLine>(lines: readonly L[], wh: string): PackRowView<L>[] {
  return lines
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(r => !wh || packWarehouseOf(r.line) === wh);
}

export function sourceTag(l: Pick<PackLine, 'sourceOrderId' | 'sourceLineNo'>): { po: string; no: number | null } | null {
  return l.sourceOrderId ? { po: l.sourceOrderId, no: l.sourceLineNo ?? null } : null;
}

export type ShipBlockers = { open: number; short: number; zero: number };

// What stands between the box and Mark shipped: lines nobody ticked, and
// lines ticked for fewer units than the order sells — the order has to be
// edited to what is in the box first.
export function shipBlockers(lines: readonly CheckableLine[], checks: ReadonlyMap<string, LineCheck>): ShipBlockers {
  const out: ShipBlockers = { open: 0, short: 0, zero: 0 };
  for (const l of lines.filter(isPackable)) {
    const c = checks.get(l.id);
    if (lineState(l, c) !== 'done') out.open += 1;
    else if (isShortChecked(l, c)) out.short += 1;
    else if (isAbsentChecked(l, c)) out.zero += 1;
  }
  return out;
}

export type PackScan<L> = ScanMatch<L> | { choose: L[] };

const partMatches = (q: string, pn: string) =>
  pn !== '' && (pn === q || (q.length >= 6 && pn.length >= 6 && (q.startsWith(pn) || pn.startsWith(q))));

// Review mode's scan, with two differences. A sell order often carries the
// same part on several lines, and a part-number label can't say which one it
// came off: rather than tick one of them on a guess, the lines still waiting
// are handed back to choose from (a serial names its lot, so it ticks). And a
// line held at 0 is never a match — there is nothing of it to pack.
export function packScan<L extends PackLine>(
  all: readonly L[], checks: ReadonlyMap<string, LineCheck>, raw: string,
): PackScan<L> | null {
  const lines = all.filter(isPackable);
  const m = matchScan(lines, checks, raw);
  if (!m || !('line' in m)) return m;
  const pn = canonicalPartNumber(m.line.partNumber);
  if (!partMatches(canonicalPartNumber(raw), pn)) return m;
  const waiting = lines.filter(l =>
    canonicalPartNumber(l.partNumber) === pn && lineState(l, checks.get(l.id)) !== 'done');
  return waiting.length > 1 ? { choose: waiting } : m;
}
