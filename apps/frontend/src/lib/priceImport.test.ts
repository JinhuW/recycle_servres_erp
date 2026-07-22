import { describe, it, expect } from 'vitest';
import { applyPriceRows } from './priceImport';

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
    const out = applyPriceRows(lines, [{ canonPart: 'ABC-123', condition: null, price: 55 }]);
    expect(out.map(l => l.unitPrice)).toEqual([55, 55, 7]);
    expect(out[0].warehouse).toBe('LA');
  });

  it('matches through prefixes, whitespace, and case in the draft line', () => {
    const lines = [line({ partNumber: 'pn: abc-123' })];
    const out = applyPriceRows(lines, [{ canonPart: 'ABC-123', condition: null, price: 10 }]);
    expect(out[0].unitPrice).toBe(10);
  });

  it('uses the condition to disambiguate colliding parts', () => {
    const lines = [
      line({ condition: 'New', unitPrice: 1 }),
      line({ condition: 'Used', unitPrice: 2 }),
    ];
    const out = applyPriceRows(lines, [{ canonPart: 'ABC-123', condition: 'new', price: 100 }]);
    expect(out.map(l => l.unitPrice)).toEqual([100, 2]);
  });

  it('a row without a condition applies to any condition', () => {
    const lines = [line({ condition: 'New' }), line({ condition: 'Used' })];
    const out = applyPriceRows(lines, [{ canonPart: 'ABC-123', condition: null, price: 9 }]);
    expect(out.map(l => l.unitPrice)).toEqual([9, 9]);
  });

  it('never touches lines without a part number', () => {
    const lines = [line({ partNumber: null, unitPrice: 3 })];
    const out = applyPriceRows(lines, [{ canonPart: '', condition: null, price: 99 }]);
    expect(out[0].unitPrice).toBe(3);
  });

  it('returns a new array and leaves the input untouched', () => {
    const lines = [line({})];
    const out = applyPriceRows(lines, [{ canonPart: 'ABC-123', condition: null, price: 42 }]);
    expect(out).not.toBe(lines);
    expect(lines[0].unitPrice).toBe(0);
    expect(out[0].unitPrice).toBe(42);
  });
});
