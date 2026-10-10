import { canonicalPartNumber } from '@recycle-erp/shared';
import {
  countOf, filterScan, isAbsentChecked, isShortChecked, lineState, matchScan, spellsSerial, tally,
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
  // The product's # on the order, which the packer labels the items with.
  no: number;
};

// `qty` is the line's on the order, which a tick on a Draft sets to the count.
// Absent from a backend older than this bundle.
export type PackRow = {
  lineId: string; qty?: number; counted: number; packedAt: string | null; serialNumber: string | null;
};
// `applied`: the lines an apply set to their counts, on its reply only.
export type PackResponse = { lines: PackRow[]; applied?: string[] };

export function toCheck(r: PackRow): LineCheck {
  return { lineId: r.lineId, counted: r.counted, checkedAt: r.packedAt };
}

// Not clamped to the qty the page last saw: taking a short tick back puts the
// line's qty back on the server, and a clamp against the lowered qty would
// write a count below the one on screen. The server bounds it.
export function packBody(c: LineCheck): { counted: number; packed: boolean } {
  return { counted: c.counted, packed: c.checkedAt !== null };
}

// The backend's own name for lines with no warehouse, on the packing-list tabs.
export const UNASSIGNED = 'Unassigned';

// Where the line's lot is now; null when it has no warehouse.
export function lotWarehouse(l: Pick<PackLine, 'warehouse' | 'packWarehouse'>): string | null {
  return l.packWarehouse === undefined ? l.warehouse : l.packWarehouse;
}

export function packWarehouseOf(l: Pick<PackLine, 'warehouse' | 'packWarehouse'>): string {
  return lotWarehouse(l) ?? UNASSIGNED;
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

// Every line in the order's own list order — # order — with its product's
// #, which the server counts over the whole order so a warehouse
// filter doesn't renumber. A ticked line stays where it is: the packer and the
// receiver both read the list by #.
// `wh` '' means every warehouse.
export function packView<L extends PackLine>(lines: readonly L[], wh: string): PackRowView<L>[] {
  return lines
    .map(line => ({ line, no: line.no }))
    .filter(r => !wh || packWarehouseOf(r.line) === wh);
}

// What the list narrows to while text sits in the scan box: Review mode's
// part/serial filter, plus the PO each lot came from — a sell order draws on
// several POs, and a packer pulling stock goes PO by PO. `PO-1343`, `po1343`
// and `1343` all fit PO-1343. Null is no filter.
export function packFilter<L extends PackLine>(lines: readonly L[], raw: string): L[] | null {
  const q = canonicalPartNumber(raw);
  if (!q) return null;
  const hits = new Set(filterScan(lines, raw));
  return lines.filter(l => hits.has(l) || fitsSourcePo(l, q));
}

function fitsSourcePo(l: PackLine, q: string): boolean {
  return !!l.sourceOrderId && canonicalPartNumber(l.sourceOrderId).includes(q);
}

// Whether some lot's PO fits the text — Enter on a PO number that no unit
// answers to is a PO filter, not a scan that missed.
export function fitsAnySourcePo(lines: readonly PackLine[], raw: string): boolean {
  const q = canonicalPartNumber(raw);
  return !!q && lines.some(l => fitsSourcePo(l, q));
}

export function sourceTag(l: Pick<PackLine, 'sourceOrderId' | 'sourceLineNo'>): { po: string; no: number | null } | null {
  return l.sourceOrderId ? { po: l.sourceOrderId, no: l.sourceLineNo ?? null } : null;
}

// A product is every line carrying one #; each line is a lot, usually a PO
// line of its own. The server puts a product's lines next to each other and in
// one warehouse, so grouping runs of a # is enough and a warehouse filter never
// splits one. A lot held at 0 has nothing to pack and is left out, as the
// packing lists leave it — unless every lot is, when `lots` is empty and the
// product still stands, by its first line, to account for its #.
export type PackProduct<L> = { no: number; lots: L[]; head: L };

export function packProducts<L extends PackLine>(rows: readonly PackRowView<L>[]): PackProduct<L>[] {
  const out: { no: number; lines: L[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.no === r.no) last.lines.push(r.line);
    else out.push({ no: r.no, lines: [r.line] });
  }
  return out.map(({ no, lines }) => {
    const lots = lines.filter(isPackable);
    return { no, lots, head: lots[0] ?? lines[0]! };
  });
}

// `mixed`: some lot is packed or lowered, and not all are packed.
export type ProductState = 'zero' | 'open' | 'mixed' | 'done';
export type ProductSummary = {
  state: ProductState; counted: number; qty: number;
  // A lot counted below its qty, and a lot counted to 0 — packed or not.
  short: boolean; zeroed: boolean;
};

export function productSummary(lots: readonly CheckableLine[], checks: ReadonlyMap<string, LineCheck>): ProductSummary {
  let counted = 0, qty = 0, done = 0, touched = 0, short = false, zeroed = false;
  for (const l of lots) {
    const c = checks.get(l.id);
    const n = countOf(l, c);
    counted += n;
    qty += l.qty;
    if (lineState(l, c) === 'done') done += 1;
    if (lineState(l, c) !== 'open') touched += 1;
    if (n === 0) zeroed = true;
    else if (n < l.qty) short = true;
  }
  const state: ProductState = lots.length === 0 ? 'zero'
    : done === lots.length ? 'done'
    : touched > 0 ? 'mixed'
    : 'open';
  return { state, counted, qty, short, zeroed };
}

export type PackGroups<L> = { open: PackProduct<L>[]; packed: PackProduct<L>[] };

// A packed product sinks under Packed, newest first, as Review mode's checked
// lines do, so what is left to pack stays on top in # order. One packed at 0
// stays at its #: nothing of it went in the box.
export function packGroups<L extends CheckableLine>(
  products: readonly PackProduct<L>[], checks: ReadonlyMap<string, LineCheck>,
): PackGroups<L> {
  const out: PackGroups<L> = { open: [], packed: [] };
  for (const p of products) {
    const s = productSummary(p.lots, checks);
    (s.state === 'done' && s.counted > 0 ? out.packed : out.open).push(p);
  }
  const at = (p: PackProduct<L>) =>
    p.lots.reduce((m, l) => { const a = checks.get(l.id)?.checkedAt ?? ''; return a > m ? a : m; }, '');
  out.packed.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
  return out;
}

// Where the selection goes once a tick packs the product it was on: the next
// one still to pack, from the top again past the last.
export function nextOpenProduct<L extends CheckableLine>(
  products: readonly PackProduct<L>[], checks: ReadonlyMap<string, LineCheck>, fromNo: number,
): PackProduct<L> | null {
  const left = (p: PackProduct<L>) => {
    const s = productSummary(p.lots, checks).state;
    return s === 'open' || s === 'mixed';
  };
  const from = products.findIndex(p => p.no === fromNo);
  return products.find((p, i) => i > from && left(p)) ?? products.find(left) ?? null;
}

export type ProductTick<L> = { tick: L[]; untick: L[]; left: L[] };

// Ticking a product packs its lots still at full count. A lot lowered and not
// yet ticked waits for its own tick, as Review mode's Check all leaves a short
// line: the tick is what confirms the short count. Once every lot is packed
// the same tick unpacks them all.
export function productTick<L extends CheckableLine>(
  lots: readonly L[], checks: ReadonlyMap<string, LineCheck>,
): ProductTick<L> {
  const states = lots.map(l => lineState(l, checks.get(l.id)));
  if (lots.length && states.every(s => s === 'done')) return { tick: [], untick: [...lots], left: [] };
  return {
    tick: lots.filter((_, i) => states[i] === 'open'),
    untick: [],
    left: lots.filter((_, i) => states[i] === 'partial' || states[i] === 'absent'),
  };
}

export type ProductTally = {
  products: number; done: number; partial: number; absent: number; open: number;
  units: number; counted: number;
};

// The progress card, one bucket per product — the rows the packer sees. A
// product is short while any lot is lowered and not yet ticked, at 0 first.
// Units are the lots' (`tally`). A product with nothing to pack isn't counted.
export function productTally<L extends CheckableLine>(
  products: readonly PackProduct<L>[], checks: ReadonlyMap<string, LineCheck>,
): ProductTally {
  const out: ProductTally = { products: 0, done: 0, partial: 0, absent: 0, open: 0, units: 0, counted: 0 };
  for (const p of products) {
    if (!p.lots.length) continue;
    const units = tally(p.lots, checks);
    out.products += 1;
    out.units += units.units;
    out.counted += units.counted;
    if (units.done === p.lots.length) out.done += 1;
    else if (units.absent > 0) out.absent += 1;
    else if (units.partial > 0) out.partial += 1;
    else out.open += 1;
  }
  return out;
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

// Lots counted below their qty and not ticked, in list order: flagged short
// or at 0, but not yet on the order. Apply ticks them all at their counts.
export function flaggedLots<L extends CheckableLine>(
  lines: readonly L[], checks: ReadonlyMap<string, LineCheck>,
): L[] {
  return lines.filter(l => {
    if (!isPackable(l)) return false;
    const s = lineState(l, checks.get(l.id));
    return s === 'partial' || s === 'absent';
  });
}

export type PackScan<L> = ScanMatch<L> | { choose: L[] };

// Review mode's scan, with two differences. A sell order often carries the
// same part on several lines, and a part-number label can't say which one it
// came off: rather than tick one of them on a guess, the lines still waiting
// are handed back to choose from (a serial names its lot, so it ticks). And a
// line held at 0 is never a match — there is nothing of it to pack. Nor is a
// lot counted down to 0 a choice: a tap on it would set its line to 0.
export function packScan<L extends PackLine>(
  all: readonly L[], checks: ReadonlyMap<string, LineCheck>, raw: string,
): PackScan<L> | null {
  const lines = all.filter(isPackable);
  const m = matchScan(lines, checks, raw);
  if (!m || !('line' in m)) return m;
  if (spellsSerial(m.line, canonicalPartNumber(raw))) return m;
  const pn = canonicalPartNumber(m.line.partNumber);
  const waiting = lines.filter(l => {
    const c = checks.get(l.id);
    return canonicalPartNumber(l.partNumber) === pn && lineState(l, c) !== 'done' && countOf(l, c) > 0;
  });
  return waiting.length > 1 ? { choose: waiting } : m;
}
