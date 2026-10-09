import { describe, it, expect } from 'vitest';
import type { LineCheck } from './boxCheck';
import {
  flaggedLots, isPackable, nextOpenProduct, packBody, packGroups, packProducts, packScan, packView, packWarehouseOptions,
  productSummary, productTally, productTick, shipBlockers, sourceTag, toCheck,
  type PackLine, type PackProduct,
} from './sellOrderPack';

const L = (id: string, o: Partial<PackLine> = {}): PackLine => ({
  id, no: 1, qty: 2, partNumber: 'PN-' + id, serialNumber: null,
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
    L('t', { no: 1, sourceOrderId: null }),
    L('b2', { no: 2, sourceOrderId: 'PO-1442', sourceLineNo: 2, packWarehouse: 'DEN' }),
    L('a3', { no: 3, sourceOrderId: 'PO-999', sourceLineNo: 3 }),
    L('z', { no: 4, qty: 0 }),
  ];

  it('lists every line in the order\'s own order with its #, ticked or not', () => {
    expect(packView(lines, '').map(r => [r.line.id, r.no])).toEqual([['t', 1], ['b2', 2], ['a3', 3], ['z', 4]]);
  });

  it('filters by warehouse without renumbering', () => {
    expect(packView(lines, 'DEN').map(r => [r.line.id, r.no])).toEqual([['b2', 2]]);
    expect(packView(lines, 'LA1').map(r => r.no)).toEqual([1, 3, 4]);
  });

  it('shows the server\'s product #, shared by the lines of one product', () => {
    const numbered = [L('a', { no: 1 }), L('b', { no: 2 }), L('c', { no: 2 }), L('d', { no: 3 })];
    expect(packView(numbered, '').map(r => [r.line.id, r.no])).toEqual([['a', 1], ['b', 2], ['c', 2], ['d', 3]]);
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

  it('never counts a line held at 0', () => {
    const ls = [L('a'), L('z', { qty: 0 })];
    expect(isPackable(ls[1]!)).toBe(false);
    expect(shipBlockers(ls, checks(C('a', 2, 'x')))).toEqual({ open: 0, short: 0, zero: 0 });
  });
});

describe('flaggedLots', () => {
  it('lists the lots lowered and not ticked, in list order', () => {
    const ls = [L('open'), L('zero'), L('short'), L('ticked-short'), L('ticked-zero'), L('full'), L('held', { qty: 0 })];
    const cs = checks(
      C('zero', 0), C('short', 1), C('ticked-short', 1, 'x'), C('ticked-zero', 0, 'x'), C('full', 2, 'x'), C('held', 0),
    );
    expect(flaggedLots(ls, cs).map(l => l.id)).toEqual(['zero', 'short']);
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

  it('asks which lot when a piece of the part number fits lines from more than one lot', () => {
    const ls = [
      L('a', { partNumber: 'M393A4K40DB3-CWE', sourceOrderId: 'PO-1', sourceLineNo: 1 }),
      L('b', { partNumber: 'M393A4K40DB3-CWE', sourceOrderId: 'PO-2', sourceLineNo: 4 }),
      L('c', { partNumber: 'SSDSC2KB960G8' }),
    ];
    expect(packScan(ls, new Map(), '4k40')).toEqual({ choose: [ls[0], ls[1]] });
    expect(packScan(ls, new Map(), 'KB960')).toEqual({ line: ls[2] });
  });

  it('ticks by serial even when the part is on several lines', () => {
    const ls = [
      L('a', { partNumber: 'M393A4K40DB3-CWE', serialNumber: 'S1, S2' }),
      L('b', { partNumber: 'M393A4K40DB3-CWE', serialNumber: 'S9' }),
    ];
    expect(packScan(ls, new Map(), 'S9')).toEqual({ line: ls[1] });
  });

  it('never lands on a line held at 0', () => {
    const ls = [
      L('a', { partNumber: 'M393A4K40DB3-CWE', qty: 0, serialNumber: 'S1' }),
      L('b', { partNumber: 'M393A4K40DB3-CWE' }),
    ];
    expect(packScan(ls, new Map(), 'M393A4K40DB3-CWE')).toEqual({ line: ls[1] });
    expect(packScan(ls, new Map(), 'S1')).toBeNull();
  });

  it('passes a miss and an ambiguous prefix through', () => {
    const ls = [L('a', { partNumber: 'ABCDEF-1' }), L('b', { partNumber: 'ABCDEF-2' })];
    expect(packScan(ls, new Map(), 'ZZZ')).toBeNull();
    expect(packScan(ls, new Map(), 'ABCDEF')).toEqual({ ambiguous: ['ABCDEF-1', 'ABCDEF-2'] });
  });
});

describe('packProducts', () => {
  it('folds the lines of one # into one product, in list order', () => {
    const ls = [L('a', { no: 1 }), L('b', { no: 2 }), L('c', { no: 2 }), L('d', { no: 3 })];
    expect(packProducts(packView(ls, '')).map(p => [p.no, p.lots.map(l => l.id)]))
      .toEqual([[1, ['a']], [2, ['b', 'c']], [3, ['d']]]);
  });

  it('leaves a lot held at 0 out of a product that still has one to pack', () => {
    const ls = [L('a', { no: 1 }), L('b', { no: 1, qty: 0 })];
    const [p] = packProducts(packView(ls, ''));
    expect(p!.lots.map(l => l.id)).toEqual(['a']);
    expect(p!.head.id).toBe('a');
  });

  it('keeps a product whose lots are all 0, with nothing to pack', () => {
    const ls = [L('a', { no: 1, qty: 0 }), L('b', { no: 1, qty: 0 }), L('c', { no: 2 })];
    const ps = packProducts(packView(ls, ''));
    expect(ps.map(p => [p.no, p.head.id, p.lots.length])).toEqual([[1, 'a', 0], [2, 'c', 1]]);
  });

});

describe('productSummary', () => {
  const lots = [L('a'), L('b'), L('c')];

  it('is open while nothing has been touched, and sums the counts', () => {
    expect(productSummary(lots, new Map())).toEqual({ state: 'open', counted: 6, qty: 6, short: false, zeroed: false });
  });

  it('is mixed once one lot is packed or lowered', () => {
    expect(productSummary(lots, checks(C('a', 2, 'x'))).state).toBe('mixed');
    const lowered = productSummary(lots, checks(C('b', 1)));
    expect(lowered).toMatchObject({ state: 'mixed', counted: 5, short: true, zeroed: false });
  });

  it('is done when every lot is packed, saying when one went short or to 0', () => {
    const all = checks(C('a', 2, 'x'), C('b', 2, 'x'), C('c', 2, 'x'));
    expect(productSummary(lots, all)).toMatchObject({ state: 'done', short: false, zeroed: false });
    const off = checks(C('a', 1, 'x'), C('b', 0, 'x'), C('c', 2, 'x'));
    expect(productSummary(lots, off)).toMatchObject({ state: 'done', counted: 3, short: true, zeroed: true });
  });

  it('is zero with no lot to pack', () => {
    expect(productSummary([], new Map()).state).toBe('zero');
  });
});

describe('packGroups', () => {
  const P = (no: number, ...lots: PackLine[]): PackProduct<PackLine> => ({ no, pid: String(no), lots, head: lots[0] ?? L('h' + no) });
  const products = [P(1, L('a')), P(2, L('b'), L('c')), P(3, L('d')), P(4), P(5, L('e'))];
  const nos = (ps: readonly PackProduct<PackLine>[]) => ps.map(p => p.no);

  it('keeps everything up, in # order, until something is packed', () => {
    expect(nos(packGroups(products, new Map()).open)).toEqual([1, 2, 3, 4, 5]);
    expect(packGroups(products, new Map()).packed).toEqual([]);
  });

  it('sinks a packed product, newest first, and a tie keeps # order', () => {
    const g = packGroups(products, checks(C('a', 2, 't1'), C('d', 2, 't2'), C('e', 2, 't1')));
    expect(nos(g.open)).toEqual([2, 4]);
    expect(nos(g.packed)).toEqual([3, 1, 5]);
  });

  it('keeps a product up while any lot is still to pack, and sinks it on the last', () => {
    expect(nos(packGroups(products, checks(C('b', 2, 't1'))).open)).toContain(2);
    const both = packGroups(products, checks(C('b', 2, 't1'), C('c', 1, 't3')));
    expect(nos(both.packed)).toEqual([2]);
  });

  it('keeps a product packed at 0, and one with no lot, at its #', () => {
    const g = packGroups(products, checks(C('a', 0, 't1'), C('b', 0, 't1'), C('c', 0, 't1')));
    expect(nos(g.open)).toEqual([1, 2, 3, 4, 5]);
    expect(g.packed).toEqual([]);
  });
});

describe('nextOpenProduct', () => {
  const P = (no: number, ...lots: PackLine[]): PackProduct<PackLine> => ({ no, pid: String(no), lots, head: lots[0] ?? L('h' + no) });
  const products = [P(1, L('a')), P(2, L('b')), P(3), P(4, L('d'), L('e'))];

  it('moves on to the next product still to pack, skipping packed and empty ones', () => {
    expect(nextOpenProduct(products, checks(C('a', 2, 'x'), C('b', 2, 'x')), '1')?.no).toBe(4);
  });

  it('counts a partly packed product as still to pack', () => {
    expect(nextOpenProduct(products, checks(C('a', 2, 'x'), C('b', 2, 'x'), C('d', 2, 'x')), '1')?.no).toBe(4);
  });

  it('goes back to the top past the last', () => {
    expect(nextOpenProduct(products, checks(C('d', 2, 'x'), C('e', 2, 'x')), '4')?.no).toBe(1);
  });

  it('is null once everything is packed', () => {
    const all = checks(C('a', 2, 'x'), C('b', 2, 'x'), C('d', 2, 'x'), C('e', 2, 'x'));
    expect(nextOpenProduct(products, all, '2')).toBeNull();
  });
});

describe('productTick', () => {
  const lots = [L('a'), L('b'), L('c')];

  it('packs every lot still at its full count and leaves a lowered one for its own tick', () => {
    const plan = productTick(lots, checks(C('a', 2, 'x'), C('c', 1)));
    expect(plan.tick.map(l => l.id)).toEqual(['b']);
    expect(plan.untick).toEqual([]);
    expect(plan.left.map(l => l.id)).toEqual(['c']);
  });

  it('unpacks every lot once all are packed', () => {
    const plan = productTick(lots, checks(C('a', 2, 'x'), C('b', 1, 'x'), C('c', 0, 'x')));
    expect(plan.untick.map(l => l.id)).toEqual(['a', 'b', 'c']);
    expect(plan.tick).toEqual([]);
  });

  it('has nothing to tick when only lowered lots are waiting', () => {
    const plan = productTick(lots, checks(C('a', 2, 'x'), C('b', 1), C('c', 0)));
    expect(plan.tick).toEqual([]);
    expect(plan.left.map(l => l.id)).toEqual(['b', 'c']);
  });

  it('does nothing for a product with no lot to pack', () => {
    expect(productTick([], new Map())).toEqual({ tick: [], untick: [], left: [] });
  });
});

describe('productTally', () => {
  it('puts each product in one bucket and counts units over its lots', () => {
    const ps = packProducts(packView([
      L('a', { no: 1 }),
      L('b', { no: 2 }), L('c', { no: 2 }),
      L('d', { no: 3 }), L('e', { no: 3 }),
      L('f', { no: 4 }),
      L('z', { no: 5, qty: 0 }),
    ], ''));
    const cs = checks(
      C('a', 2, 'x'),
      C('b', 2, 'x'), C('c', 1),
      C('d', 0), C('e', 1),
    );
    expect(productTally(ps, cs)).toEqual({
      products: 4, done: 1, partial: 1, absent: 1, open: 1, units: 12, counted: 4,
    });
  });
});

describe('a product is what the server folds, not its # alone', () => {
  it('keeps two lots that share a # but no longer read alike as two products', () => {
    const ls = [
      L('a', { no: 1, product: '#1|TW' }), L('b', { no: 1, product: '#1|TX' }), L('c', { no: 2, product: '#2|Z' }),
    ];
    expect(packProducts(packView(ls, '')).map(p => [p.no, p.pid, p.lots.map(l => l.id)]))
      .toEqual([[1, '#1|TW', ['a']], [1, '#1|TX', ['b']], [2, '#2|Z', ['c']]]);
  });

  it('falls back to the # for a backend that sends no product', () => {
    const ls = [L('a', { no: 1 }), L('b', { no: 1 })];
    expect(packProducts(packView(ls, '')).map(p => p.pid)).toEqual(['1']);
  });
});
