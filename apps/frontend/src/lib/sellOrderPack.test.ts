import { describe, it, expect } from 'vitest';
import type { LineCheck } from './boxCheck';
import {
  packBody, packScan, packView, packWarehouseOptions, shipBlockers, sourceTag, toCheck,
  type PackLine,
} from './sellOrderPack';

const L = (id: string, o: Partial<PackLine> = {}): PackLine => ({
  id, qty: 2, partNumber: 'PN-' + id, serialNumber: null,
  warehouseId: 'WH-LA1', warehouse: 'LA1', sourceOrderId: null, sourceLineNo: null, ...o,
});
const C = (lineId: string, counted: number, checkedAt: string | null = null): LineCheck =>
  ({ lineId, counted, checkedAt });
const checks = (...cs: LineCheck[]) => new Map(cs.map(c => [c.lineId, c]));

describe('toCheck / packBody', () => {
  it('maps packedAt onto the check and back to a body', () => {
    const c = toCheck({ lineId: 'a', counted: 1, packedAt: '2026-10-07T00:00:00Z', serialNumber: null });
    expect(c).toEqual({ lineId: 'a', counted: 1, checkedAt: '2026-10-07T00:00:00Z' });
    expect(packBody(c, 2)).toEqual({ counted: 1, packed: true });
    expect(packBody({ ...c, counted: 5, checkedAt: null }, 3)).toEqual({ counted: 3, packed: false });
  });
});

describe('packWarehouseOptions', () => {
  it('goes by where the lot is now, alphabetical, unassigned last', () => {
    expect(packWarehouseOptions([
      { warehouse: 'LA1', packWarehouse: 'DEN' },
      { warehouse: null, packWarehouse: null },
      { warehouse: 'NJ1' },
      { warehouse: 'LA1', packWarehouse: 'DEN' },
    ])).toEqual(['DEN', 'NJ1', 'Unassigned']);
  });
});

describe('packView', () => {
  const lines = [
    L('t', { sourceOrderId: null }),
    L('b2', { sourceOrderId: 'PO-1442', sourceLineNo: 2, packWarehouse: 'DEN' }),
    L('a3', { sourceOrderId: 'PO-999', sourceLineNo: 3 }),
    L('b1', { sourceOrderId: 'PO-1442', sourceLineNo: 1, packWarehouse: 'DEN' }),
    L('a1', { sourceOrderId: 'PO-999', sourceLineNo: 1 }),
  ];

  it('groups open lines by PO in numeric order, PO line order inside, hand-typed last', () => {
    const v = packView(lines, new Map(), '');
    expect(v.groups.map(g => g.poId)).toEqual(['PO-999', 'PO-1442', null]);
    expect(v.groups[0]!.items.map(i => i.line.id)).toEqual(['a1', 'a3']);
    expect(v.groups[1]!.items.map(i => i.line.id)).toEqual(['b1', 'b2']);
    expect(v.groups[1]!.warehouse).toBe('DEN');
    expect(v.done).toEqual([]);
  });

  it('sinks packed lines newest first and filters by warehouse', () => {
    const cs = checks(C('a1', 2, '2026-10-07T01:00:00Z'), C('b1', 2, '2026-10-07T02:00:00Z'));
    const v = packView(lines, cs, '');
    expect(v.done.map(l => l.id)).toEqual(['b1', 'a1']);
    expect(v.groups[0]!.items.map(i => i.line.id)).toEqual(['a3']);

    const den = packView(lines, cs, 'DEN');
    expect(den.groups.map(g => g.poId)).toEqual(['PO-1442']);
    expect(den.done.map(l => l.id)).toEqual(['b1']);
  });
});

describe('sourceTag', () => {
  it('reads the PO and its line number; a hand-typed line has none', () => {
    expect(sourceTag({ sourceOrderId: 'PO-1111', sourceLineNo: 1 })).toEqual({ po: 'PO-1111', no: 1 });
    expect(sourceTag({ sourceOrderId: 'PO-1111' })).toEqual({ po: 'PO-1111', no: null });
    expect(sourceTag({ sourceOrderId: null, sourceLineNo: null })).toBeNull();
  });
});

describe('shipBlockers', () => {
  it('counts lines not ticked, ticked short and ticked at 0', () => {
    const ls = [L('a'), L('b'), L('c'), L('d'), L('e')];
    const cs = checks(
      C('a', 2, 'x'), C('b', 1, 'x'), C('c', 0, 'x'), C('d', 1),
    );
    expect(shipBlockers(ls, cs)).toEqual({ open: 2, short: 1, zero: 1 });
  });
});

describe('packScan', () => {
  it('ticks the one line a part number names', () => {
    const ls = [L('a', { partNumber: 'M393A4K40DB3-CWE' }), L('b')];
    expect(packScan(ls, new Map(), 'm393a4k40db3cwe')).toEqual({ line: ls[0] });
  });

  it('asks which lot when the part is waiting on lines from more than one lot', () => {
    const ls = [
      L('a', { partNumber: 'M393A4K40DB3-CWE', sourceOrderId: 'PO-1', sourceLineNo: 1 }),
      L('b', { partNumber: 'M393A4K40DB3-CWE', sourceOrderId: 'PO-2', sourceLineNo: 4 }),
    ];
    expect(packScan(ls, new Map(), 'M393A4K40DB3-CWE')).toEqual({ choose: ls });
    // A label with a suffix names the same part.
    expect(packScan(ls, new Map(), 'M393A4K40DB3-CWE-T')).toEqual({ choose: ls });
  });

  it('stops asking once only one of those lots is still waiting', () => {
    const ls = [
      L('a', { partNumber: 'M393A4K40DB3-CWE' }),
      L('b', { partNumber: 'M393A4K40DB3-CWE' }),
    ];
    expect(packScan(ls, checks(C('a', 2, 'x')), 'M393A4K40DB3-CWE')).toEqual({ line: ls[1] });
  });

  it('ticks by serial even when the part is on several lines', () => {
    const ls = [
      L('a', { partNumber: 'M393A4K40DB3-CWE', serialNumber: 'S1, S2' }),
      L('b', { partNumber: 'M393A4K40DB3-CWE', serialNumber: 'S9' }),
    ];
    expect(packScan(ls, new Map(), 'S9')).toEqual({ line: ls[1] });
  });

  it('passes a miss and an ambiguous prefix through', () => {
    const ls = [L('a', { partNumber: 'ABCDEF-1' }), L('b', { partNumber: 'ABCDEF-2' })];
    expect(packScan(ls, new Map(), 'ZZZ')).toBeNull();
    expect(packScan(ls, new Map(), 'ABCDEF')).toEqual({ ambiguous: ['ABCDEF-1', 'ABCDEF-2'] });
  });
});
