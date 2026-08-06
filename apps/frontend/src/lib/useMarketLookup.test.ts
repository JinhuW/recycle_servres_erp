import { describe, it, expect } from 'vitest';
import { lookupKeys, resolveMarket, type MarketValue } from './useMarketLookup';

// The hook batches every part number on screen into one request and keys the
// result canonically, so a PN typed with a `P/N ` prefix or stray spaces still
// finds the row the server matched. Both halves of that are pure.

const VALUE: MarketValue = {
  partNumber: 'M393A4K40DB3-CWE', label: 'Samsung 32GB', avgSell: 80, lastPrice: 90,
  lastPriceAt: null, lastPriceSource: null, maxBuy: 63, low: null, high: null,
  samples: 3, internalSales: { avgPrice: null, samples: 0 },
};

describe('lookupKeys', () => {
  it('dedupes, drops blanks, and canonicalises', () => {
    expect(lookupKeys(['A-1', 'A-1', '', null, undefined, 'b-2']))
      .toEqual(['A-1', 'B-2']);
  });

  it('collapses the label spellings of one part to a single request key', () => {
    expect(lookupKeys(['M393A4K40DB3-CWE', 'P/N: M393A4K40DB3-CWE', 'm393a4k40db3-cwe']))
      .toEqual(['M393A4K40DB3-CWE']);
  });

  it('is order-independent so an unchanged set does not refetch', () => {
    expect(lookupKeys(['B', 'A']).join(' ')).toBe(lookupKeys(['A', 'B']).join(' '));
  });

  it('returns nothing when there is nothing to look up', () => {
    expect(lookupKeys([null, '', undefined])).toEqual([]);
  });
});

describe('resolveMarket', () => {
  const values = new Map([['M393A4K40DB3-CWE', VALUE]]);

  it('resolves the exact part number', () => {
    expect(resolveMarket(values, 'M393A4K40DB3-CWE')?.maxBuy).toBe(63);
  });

  it('resolves the same part written the way a label prints it', () => {
    expect(resolveMarket(values, 'P/N: M393A4K40DB3-CWE')?.maxBuy).toBe(63);
    expect(resolveMarket(values, ' m393a4k40db3-cwe ')?.maxBuy).toBe(63);
  });

  it('returns null for an unknown or blank part', () => {
    expect(resolveMarket(values, 'UNKNOWN')).toBeNull();
    expect(resolveMarket(values, '')).toBeNull();
    expect(resolveMarket(values, null)).toBeNull();
  });
});
