import { describe, it, expect } from 'vitest';
import { groupSellOrderLines } from './sellOrderLineGroups';

const line = (id: string, warehouseId: string | null, sourceOrderId: string | null) => ({
  id, warehouseId, warehouse: warehouseId && warehouseId.replace('WH-', ''), sourceOrderId,
});

const lines = [
  line('a', 'WH-DEN', 'PO-1442'),
  line('b', 'WH-LA1', null),
  line('c', 'WH-DEN', 'PO-999'),
  line('d', null, 'PO-1442'),
  line('e', 'WH-LA1', 'PO-1001'),
];

describe('groupSellOrderLines', () => {
  it('groups by warehouse in first-seen order', () => {
    const g = groupSellOrderLines(lines, 'warehouse');
    expect(g.map(x => x.key)).toEqual(['WH-DEN', 'WH-LA1', '__none']);
    expect(g[0].items.map(i => i.line.id)).toEqual(['a', 'c']);
    expect(g[0].poId).toBeNull();
  });

  it('groups by PO in numeric order with hand-typed lines last', () => {
    const g = groupSellOrderLines(lines, 'po');
    expect(g.map(x => x.poId)).toEqual(['PO-999', 'PO-1001', 'PO-1442', null]);
    expect(g[2].items.map(i => i.line.id)).toEqual(['a', 'd']);
    expect(g[3].items.map(i => i.line.id)).toEqual(['b']);
  });

  it('keeps each line\'s flat index', () => {
    const g = groupSellOrderLines(lines, 'po');
    expect(g.flatMap(x => x.items).map(i => [i.line.id, i.idx]).sort()).toEqual([
      ['a', 0], ['b', 1], ['c', 2], ['d', 3], ['e', 4],
    ]);
  });

  it('keeps the server\'s packing-list order inside a group, both ways', () => {
    const sameOrder = [
      line('a', 'WH-DEN', 'PO-1442'),
      line('b', 'WH-DEN', 'PO-1442'),
      line('c', 'WH-LA1', 'PO-1442'),
      line('d', 'WH-DEN', 'PO-1442'),
    ];
    const [g] = groupSellOrderLines(sameOrder, 'po');
    expect(g.items.map(i => [i.line.id, i.idx])).toEqual([['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
    expect(groupSellOrderLines(sameOrder, 'warehouse')[0].items.map(i => i.line.id))
      .toEqual(['a', 'b', 'd']);
  });

  it('treats a missing sourceOrderId as hand-typed', () => {
    const g = groupSellOrderLines([{ warehouseId: 'WH-DEN', warehouse: 'DEN' }], 'po');
    expect(g).toHaveLength(1);
    expect(g[0].poId).toBeNull();
  });
});
