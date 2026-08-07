import { describe, it, expect } from 'vitest';
import { groupLines, shouldGroup, displayRows } from './lineGroups';

// The grouped table and the per-category cost breakdown both read this, so a
// disagreement here would show as a subtotal that doesn't match its group.

const line = (category: string, qty: number, unitCost: number, sellPrice?: number) =>
  ({ category, qty, unitCost, ...(sellPrice === undefined ? {} : { sellPrice }) });

describe('shouldGroup', () => {
  it('is false for a single-category order — one header restating the total is noise', () => {
    expect(shouldGroup([line('RAM', 1, 10), line('RAM', 2, 20)])).toBe(false);
  });

  it('is true as soon as a second category appears', () => {
    expect(shouldGroup([line('RAM', 1, 10), line('SSD', 1, 10)])).toBe(true);
  });

  it('is false for an empty order', () => {
    expect(shouldGroup([])).toBe(false);
  });
});

describe('groupLines', () => {
  const lines = [
    line('SSD', 12, 71.66, 96),
    line('RAM', 200, 20.6, 28.4),
    line('Other', 4, 52.5),
    line('RAM', 96, 11.25),
  ];

  it('orders groups the way exports and pickers do, not by first appearance', () => {
    expect(groupLines(lines).map(g => g.category)).toEqual(['RAM', 'SSD', 'Other']);
  });

  it('keeps each line’s original index so row handlers still address the right line', () => {
    const ram = groupLines(lines).find(g => g.category === 'RAM')!;
    expect(ram.lines.map(m => m.index)).toEqual([1, 3]);
  });

  it('subtotals goods and units per group', () => {
    const [ram, ssd, other] = groupLines(lines);
    expect(ram.goods).toBeCloseTo(200 * 20.6 + 96 * 11.25, 2);
    expect(ram.units).toBe(296);
    expect(ssd.goods).toBeCloseTo(12 * 71.66, 2);
    expect(other.goods).toBeCloseTo(4 * 52.5, 2);
  });

  it('group subtotals sum to the order’s goods total', () => {
    const sum = groupLines(lines).reduce((a, g) => a + g.goods, 0);
    const flat = lines.reduce((a, l) => a + l.qty * l.unitCost, 0);
    expect(sum).toBeCloseTo(flat, 2);
  });

  it('counts profit over priced lines only, matching the ledger', () => {
    const ram = groupLines(lines).find(g => g.category === 'RAM')!;
    // The 96 × $11.25 line has no sell price, so it contributes nothing.
    expect(ram.profit).toBeCloseTo(200 * (28.4 - 20.6), 2);
    expect(ram.unpriced).toBe(1);
  });

  it('reports a group with nothing priced as zero profit, not a loss', () => {
    const other = groupLines(lines).find(g => g.category === 'Other')!;
    expect(other.profit).toBe(0);
    expect(other.unpriced).toBe(1);
  });

  it('sorts an unknown category last rather than dropping it', () => {
    const withCpu = [...lines, line('CPU', 1, 5)];
    expect(groupLines(withCpu).map(g => g.category)).toEqual(['RAM', 'SSD', 'Other', 'CPU']);
  });

  it('tolerates the string-typed qty/cost the submit form holds', () => {
    const [g] = groupLines([{ category: 'RAM', qty: '4', unitCost: '2.50' }]);
    expect(g.goods).toBeCloseTo(10, 2);
    expect(g.units).toBe(4);
  });
});

describe('displayRows', () => {
  const mixed = [line('RAM', 1, 10), line('SSD', 1, 20), line('RAM', 2, 30)];
  const rows = (lines: ReturnType<typeof line>[], folded: string[] = []) =>
    displayRows(lines, groupLines(lines), shouldGroup(lines), new Set(folded));

  it('walks a mixed PO group by group, each group headed once', () => {
    expect(rows(mixed).map(r => [r.index, r.head])).toEqual([[0, 'RAM'], [2, null], [1, 'SSD']]);
  });

  it('leaves a single-category PO in position order with no headers', () => {
    const flat = [line('RAM', 1, 10), line('RAM', 2, 20)];
    expect(rows(flat).map(r => [r.index, r.head, r.hidden])).toEqual([[0, null, false], [1, null, false]]);
  });

  it('hides every member of a folded group, not just the one carrying the head', () => {
    expect(rows(mixed, ['RAM']).filter(r => r.hidden).map(r => r.index)).toEqual([0, 2]);
    // The head survives, so there is still something to click to unfold.
    expect(rows(mixed, ['RAM']).find(r => r.index === 0)!.head).toBe('RAM');
  });

  // Fold state outlives the headers that toggle it. Fold RAM on a RAM+SSD PO,
  // then delete the SSD line: no header is emitted for anything any more, so a
  // row hidden on fold state alone would sit behind a toggle that is no longer
  // on screen — an items table that looks empty, with no way back but a reload.
  it('stops folding once the PO is no longer mixed, headers or not', () => {
    const noLongerMixed = [line('RAM', 1, 10), line('RAM', 2, 30)];
    expect(rows(noLongerMixed, ['RAM']).every(r => !r.hidden)).toBe(true);
  });
});
