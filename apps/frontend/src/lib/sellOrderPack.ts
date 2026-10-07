import { canonicalPartNumber } from '@recycle-erp/shared';
import {
  isAbsentChecked, isShortChecked, lineState, matchScan, orderLines,
  type CheckableLine, type LineCheck, type ScanMatch,
} from './boxCheck';
import { groupSellOrderLines, type SellOrderLineGroup } from './sellOrderLineGroups';

// Pack mode: a manager ticking a sell order's lines into the box. The count
// and tick rules are Review mode's (lib/boxCheck.ts), applied to sell lines;
// this adds what packing needs on top — where each lot sits, and which lot a
// scan meant. Pure — the page owns the state.

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

export type PackView<L> = { groups: SellOrderLineGroup<L>[]; done: L[] };

// Open lines read like the "Packing list by PO" download — by source PO, in
// that PO's own line order — because that is how the lots are found on the
// shelf. Packed lines sink, newest first. `wh` '' means every warehouse.
export function packView<L extends PackLine>(
  lines: readonly L[], checks: ReadonlyMap<string, LineCheck>, wh: string,
): PackView<L> {
  const shown = wh ? lines.filter(l => packWarehouseOf(l) === wh) : lines;
  const { open, done } = orderLines(shown, checks);
  // A group's head names where its lots are now, not where the line was saved.
  const groups = groupSellOrderLines(open.map(l => ({ ...l, warehouse: packWarehouseOf(l) })), 'po');
  return { groups, done };
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
  for (const l of lines) {
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

// Review mode's scan, with one difference: a sell order often carries the
// same part from several lots, and a part-number label can't say which lot it
// came off. Rather than tick one of them on a guess, the lines still waiting
// are handed back to choose from. A serial names its lot, so it ticks.
export function packScan<L extends PackLine>(
  lines: readonly L[], checks: ReadonlyMap<string, LineCheck>, raw: string,
): PackScan<L> | null {
  const m = matchScan(lines, checks, raw);
  if (!m || !('line' in m)) return m;
  const pn = canonicalPartNumber(m.line.partNumber);
  if (!partMatches(canonicalPartNumber(raw), pn)) return m;
  const waiting = lines.filter(l =>
    canonicalPartNumber(l.partNumber) === pn && lineState(l, checks.get(l.id)) !== 'done');
  return waiting.length > 1 ? { choose: waiting } : m;
}
