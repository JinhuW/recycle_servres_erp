import { describe, it, expect } from 'vitest';
import { applyPriceRows, marketSyncParts } from './priceImport';

type Line = {
  partNumber: string | null;
  condition: string | null;
  unitPrice: number;
  warehouse?: string;
};

const line = (over: Partial<Line>): Line => ({
  partNumber: 'ABC-123',
  condition: null,
  unitPrice: 0,
  ...over,
});

describe('applyPriceRows', () => {
  it('applies a price to every line sharing the canonical part number', () => {
    const lines = [
      line({ warehouse: 'LA' }),
      line({ warehouse: 'NJ' }),
      line({ partNumber: 'OTHER-9', unitPrice: 7 }),
    ];
    const out = applyPriceRows(lines, [{ canonPart: 'ABC123', price: 55 }]);
    expect(out.map(l => l.unitPrice)).toEqual([55, 55, 7]);
    expect(out[0].warehouse).toBe('LA');
  });

  it('matches through prefixes, separators, and case in the draft line', () => {
    const lines = [line({ partNumber: 'pn: abc_123' })];
    const out = applyPriceRows(lines, [{ canonPart: 'ABC123', price: 10 }]);
    expect(out[0].unitPrice).toBe(10);
  });

  it('prices every condition of the part alike', () => {
    const lines = [
      line({ condition: 'New', unitPrice: 1 }),
      line({ condition: 'Used', unitPrice: 2 }),
    ];
    const out = applyPriceRows(lines, [{ canonPart: 'ABC123', price: 100 }]);
    expect(out.map(l => l.unitPrice)).toEqual([100, 100]);
  });

  it('never touches lines without a part number', () => {
    const lines = [line({ partNumber: null, unitPrice: 3 })];
    const out = applyPriceRows(lines, [{ canonPart: '', price: 99 }]);
    expect(out[0].unitPrice).toBe(3);
  });

  it('returns a new array and leaves the input untouched', () => {
    const lines = [line({})];
    const out = applyPriceRows(lines, [{ canonPart: 'ABC123', price: 42 }]);
    expect(out).not.toBe(lines);
    expect(lines[0].unitPrice).toBe(0);
    expect(out[0].unitPrice).toBe(42);
  });
});

describe('marketSyncParts', () => {
  const l = (partNumber: string | null, qty: number, nativeUnitPrice: number) =>
    ({ partNumber, label: 'DIMM', qty, nativeUnitPrice, unitPrice: nativeUnitPrice });

  it('rolls a part\'s lines into one qty-weighted price', () => {
    const parts = marketSyncParts([l('ABC-123', 2, 100), l('abc123', 3, 50), l('XYZ-9', 1, 7)]);
    expect(parts.map(p => [p.canonPart, p.qty, p.price, p.lineCount])).toEqual([
      ['ABC123', 5, 70, 2],
      ['XYZ9', 1, 7, 1],
    ]);
  });

  it('leaves a lot priced at 0 out of the average, and carries the USD apart', () => {
    const [part] = marketSyncParts([
      { partNumber: 'ABC-123', label: 'DIMM', qty: 10, nativeUnitPrice: 720, unitPrice: 100 },
      { partNumber: 'ABC-123', label: 'DIMM', qty: 5, nativeUnitPrice: 0, unitPrice: 0 },
    ]);
    expect(part).toMatchObject({ qty: 10, price: 720, usdPrice: 100, lineCount: 1 });
  });

  it('leaves out lines at 0, unpriced parts and lines with no part number', () => {
    expect(marketSyncParts([l('ABC-123', 0, 100), l('XYZ-9', 4, 0), l(null, 1, 5)])).toEqual([]);
  });
});
