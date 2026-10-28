import { describe, it, expect } from 'vitest';
import { filterLineGroups, groupSellOrderLines } from './sellOrderLineGroups';

const line = (id: string, warehouseId: string | null, sourceOrderId: string | null) => {
  const warehouse = warehouseId && warehouseId.replace('WH-', '');
  return { id, warehouseId, warehouse, packWarehouse: warehouse, sourceOrderId };
};

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
    expect(g.map(x => x.key)).toEqual(['DEN', 'LA1', '__none']);
    expect(g.map(x => x.warehouse)).toEqual(['DEN', 'LA1', null]);
    expect(g[0].items.map(i => i.line.id)).toEqual(['a', 'c']);
    expect(g[0].poId).toBeNull();
  });

  it('groups a lot by where it is now, not where the line was saved', () => {
    const moved = { ...line('m', 'WH-LA1', 'PO-1442'), packWarehouse: 'NJ2' };
    const g = groupSellOrderLines([line('a', 'WH-NJ2', 'PO-999'), moved, line('b', 'WH-LA1', 'PO-1001')], 'warehouse');
    expect(g.map(x => x.warehouse)).toEqual(['NJ2', 'LA1']);
    expect(g[0].items.map(i => [i.line.id, i.idx])).toEqual([['a', 0], ['m', 1]]);
  });

  it('groups a line with no packWarehouse by its own warehouse', () => {
    const typed = { warehouseId: 'WH-LA1', warehouse: 'LA1', sourceOrderId: null };
    const g = groupSellOrderLines([line('a', 'WH-NJ2', 'PO-999'), typed], 'warehouse');
    expect(g.map(x => x.warehouse)).toEqual(['NJ2', 'LA1']);
    expect(g[1].items.map(i => i.idx)).toEqual([1]);
  });

  it('puts a lot whose current warehouse is unknown in the no-warehouse group', () => {
    const g = groupSellOrderLines([{ ...line('a', 'WH-LA1', 'PO-999'), packWarehouse: null }], 'warehouse');
    expect(g.map(x => [x.key, x.warehouse])).toEqual([['__none', null]]);
  });

  it('groups by PO in numeric order with hand-typed lines last', () => {
    const g = groupSellOrderLines(lines, 'po');
    expect(g.map(x => x.poId)).toEqual(['PO-999', 'PO-1001', 'PO-1442', null]);
    expect(g[2].items.map(i => i.line.id)).toEqual(['a', 'd']);
    expect(g[3].items.map(i => i.line.id)).toEqual(['b']);
  });

  it('combines every line into one group in input order', () => {
    const g = groupSellOrderLines(lines, 'none');
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ key: '__all', warehouse: null, poId: null });
    expect(g[0].items.map(i => [i.line.id, i.idx])).toEqual([
      ['a', 0], ['b', 1], ['c', 2], ['d', 3], ['e', 4],
    ]);
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

describe('filterLineGroups', () => {
  const items = [
    { ...line('a', 'WH-DEN', 'PO-1442'), label: 'Samsung 64GB DDR4', partNumber: 'M393A8G40AB2-CWE', serialNumber: null },
    { ...line('b', 'WH-LA1', null), label: 'Intel Xeon Gold 6248', partNumber: null, serialNumber: 'SN-77X' },
    { ...line('c', 'WH-DEN', 'PO-999'), label: 'Hynix 32GB DDR4', partNumber: 'HMA84GR7CJR4N-XN', serialNumber: null },
  ];
  const groups = groupSellOrderLines(items, 'warehouse');
  const ids = (raw: string) => filterLineGroups(groups, raw).flatMap(g => g.items.map(i => i.line.id));

  it('leaves every group alone with no text', () => {
    expect(filterLineGroups(groups, '  ')).toEqual(groups);
  });

  it('fits a part number with or without its dashes, any case', () => {
    expect(ids('m393a8g40ab2cwe')).toEqual(['a']);
    expect(ids('8G40AB2-C')).toEqual(['a']);
  });

  it('fits a serial, a PO number and the item name', () => {
    expect(ids('sn77x')).toEqual(['b']);
    expect(ids('PO-999')).toEqual(['c']);
    expect(ids('ddr4')).toEqual(['a', 'c']);
    expect(ids('xeon gold')).toEqual(['b']);
  });

  it('fits the spec chips, every word somewhere in the row', () => {
    const chips = groupSellOrderLines([
      { ...items[0], label: 'Samsung 32GB Laptop', type: 'DDR4', formFactor: 'SODIMM', speed: '2666MHz' },
      { ...items[2], label: 'Hynix 32GB', type: 'DDR5', formFactor: 'RDIMM' },
    ], 'warehouse');
    const hit = (raw: string) => filterLineGroups(chips, raw).flatMap(g => g.items.map(i => i.line.id));
    expect(hit('sodimm 2666')).toEqual(['a']);
    expect(hit('32gb rdimm')).toEqual(['c']);
    expect(hit('samsung rdimm')).toEqual([]);
  });

  it('drops a group nothing in fits and keeps each line its flat index', () => {
    const out = filterLineGroups(groups, 'HMA84');
    expect(out.map(g => g.key)).toEqual(['DEN']);
    expect(out[0].items).toEqual([{ line: items[2], idx: 2 }]);
  });
});
