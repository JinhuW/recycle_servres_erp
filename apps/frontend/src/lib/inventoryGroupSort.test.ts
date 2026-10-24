import { describe, expect, it } from 'vitest';
import { productLabel, sortProductGroups, type SortableProductGroup } from '@recycle-erp/shared';

const group = (key: string, over: Partial<SortableProductGroup> = {}): SortableProductGroup & { key: string } => ({
  key,
  category: 'RAM', brand: 'Samsung', capacity: '32GB', generation: 'DDR4', type: 'RDIMM',
  classification: null, rank: null, speed: null, interface: null, form_factor: null,
  description: null, item_type: null, rpm: null,
  part_number: `PN-${key}`, qty: 1, lot_count: 1, po_count: 1, warehouses: ['LA1'],
  sell_price: 10,
  ...over,
});
const keys = (gs: { key: string }[]) => gs.map(g => g.key);

describe('sortProductGroups', () => {
  it('sorts the product name with numbers collated, not lexically', () => {
    const gs = [group('128', { capacity: '128GB' }), group('16', { capacity: '16GB' }), group('64', { capacity: '64GB' })];
    expect(productLabel(gs[1])).toBe('Samsung 16GB DDR4');
    expect(keys(sortProductGroups(gs, 'product', 'asc'))).toEqual(['16', '64', '128']);
    expect(keys(sortProductGroups(gs, 'product', 'desc'))).toEqual(['128', '64', '16']);
  });

  it('puts blanks last in both directions', () => {
    const gs = [
      group('none', { part_number: null, warehouses: [], sell_price: null }),
      group('b', { part_number: 'B-1', warehouses: ['LA1'], sell_price: 20 }),
      group('a', { part_number: 'A-1', warehouses: ['DEN'], sell_price: 5 }),
    ];
    for (const col of ['partNumber', 'warehouses', 'sell'] as const) {
      expect(keys(sortProductGroups(gs, col, 'asc'))).toEqual(['a', 'b', 'none']);
      expect(keys(sortProductGroups(gs, col, 'desc'))).toEqual(['b', 'a', 'none']);
    }
  });

  it('sorts cost on the average, and leaves groups without one where they were', () => {
    const priced = [group('lo', { unit_cost_avg: 10 }), group('hi', { unit_cost_avg: 90 })];
    expect(keys(sortProductGroups(priced, 'cost', 'desc'))).toEqual(['hi', 'lo']);
    const purchaser = [group('x'), group('y'), group('z')];
    expect(keys(sortProductGroups(purchaser, 'cost', 'desc'))).toEqual(['x', 'y', 'z']);
  });

  it('keeps the incoming order for ties', () => {
    const gs = [group('first', { qty: 3 }), group('big', { qty: 9 }), group('second', { qty: 3 })];
    expect(keys(sortProductGroups(gs, 'qty', 'desc'))).toEqual(['big', 'first', 'second']);
    expect(keys(sortProductGroups(gs, 'qty', 'asc'))).toEqual(['first', 'second', 'big']);
  });

  it('breaks a lot-count tie on the PO count', () => {
    const gs = [group('one-po', { lot_count: 4, po_count: 1 }), group('three-pos', { lot_count: 4, po_count: 3 }), group('few', { lot_count: 2 })];
    expect(keys(sortProductGroups(gs, 'lots', 'desc'))).toEqual(['three-pos', 'one-po', 'few']);
    expect(keys(sortProductGroups(gs, 'lots', 'asc'))).toEqual(['few', 'one-po', 'three-pos']);
  });
});
