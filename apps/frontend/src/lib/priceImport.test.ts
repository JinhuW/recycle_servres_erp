import { describe, it, expect } from 'vitest';
import { applyPriceRows, confirmedBidParts, mergeBidParts } from './priceImport';

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

describe('mergeBidParts', () => {
  it('keys on the part so a re-import replaces, not repeats', () => {
    const first = mergeBidParts([], [
      { canonPart: 'ABC123', price: 10 },
      { canonPart: 'XYZ9', price: 5 },
    ]);
    expect(first).toEqual([{ partNumber: 'ABC123', price: 10 }, { partNumber: 'XYZ9', price: 5 }]);
    const again = mergeBidParts(first, [{ canonPart: 'ABC123', price: 12 }]);
    expect(again).toEqual([{ partNumber: 'ABC123', price: 12 }, { partNumber: 'XYZ9', price: 5 }]);
  });
});

describe('confirmedBidParts', () => {
  const bids = [{ partNumber: 'ABC123', price: 40 }, { partNumber: 'XYZ9', price: 5 }, { partNumber: 'GONE1', price: 9 }];

  it('sends a part still at the sheet\'s price on every line', () => {
    const lines = [line({ unitPrice: 40 }), line({ unitPrice: 40, condition: 'Used' }), line({ partNumber: 'xyz-9', unitPrice: 5 })];
    expect(confirmedBidParts(lines, bids)).toEqual([{ partNumber: 'ABC123' }, { partNumber: 'XYZ9' }]);
  });

  it('drops a part whose price was typed over on any line, and one no longer on the order', () => {
    const lines = [line({ unitPrice: 40 }), line({ unitPrice: 25 }), line({ partNumber: 'XYZ-9', unitPrice: 5 })];
    expect(confirmedBidParts(lines, bids)).toEqual([{ partNumber: 'XYZ9' }]);
  });
});
