import { describe, it, expect } from 'vitest';
import { diffSellOrderLines, type SOLineSnap } from '../src/services/sellOrderLineMatch';

const snap = (over: Partial<SOLineSnap> = {}): SOLineSnap => ({
  inventory_id: 'lot-a', category: 'RAM', label: 'x', sub_label: null, part_number: 'PN',
  condition: null, warehouse_id: null, qty: 1, unit_price: 10, ...over,
});

// An order may name one lot twice (two conditions, two prices). Keyed on one
// entry per lot, the second occurrence overwrote the first and an edit to it
// was never in the order's history.
describe('diffSellOrderLines with a lot named more than once', () => {
  it('reports an edit to the first occurrence exactly once', () => {
    const before = [snap({ qty: 1 }), snap({ qty: 2 })];
    const after = [snap({ qty: 10 }), snap({ qty: 2 })];
    const d = diffSellOrderLines(before, after);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.edited).toHaveLength(1);
    expect(d.edited[0].changes.map((c) => c.field)).toEqual(['qty']);
  });

  it('reports a removed second occurrence as removed, not as nothing', () => {
    const d = diffSellOrderLines([snap({ qty: 1 }), snap({ qty: 2 })], [snap({ qty: 1 })]);
    expect(d.removed).toEqual([snap({ qty: 2 })]);
    expect(d.edited).toEqual([]);
  });

  it('reports an added second occurrence as added', () => {
    const d = diffSellOrderLines([snap({ qty: 1 })], [snap({ qty: 1 }), snap({ qty: 3 })]);
    expect(d.added).toEqual([snap({ qty: 3 })]);
  });

  it('matches lot ids case-insensitively, as the order does', () => {
    const d = diffSellOrderLines([snap({ inventory_id: 'ABC' })], [snap({ inventory_id: 'abc', qty: 5 })]);
    expect(d.edited).toHaveLength(1);
    expect(d.added).toEqual([]);
  });
});
