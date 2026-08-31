import { describe, it, expect } from 'vitest';
import {
  lookupKeys, resolveMarket, TARGET_MARGIN_FALLBACK, type MarketValue,
} from './useMarketLookup';

// The hook batches every part number on screen into one request and keys the
// result canonically, so a PN typed with a `P/N ` prefix or stray spaces still
// finds the row the server matched. Both halves of that are pure.

const VALUE: MarketValue = {
  partNumber: 'M393A4K40DB3-CWE', label: 'Samsung 32GB', source: 'eBay', demand: 'medium',
  avgSell: 80, lastPrice: 90, lastPriceAt: null, lastPriceSource: null, maxBuy: 63,
  target: null, low: null, high: null, samples: 3, updatedAt: '2026-08-01T00:00:00.000Z',
  internalSales: { avgPrice: null, samples: 0 },
};

// Spelled as escapes: a literal non-breaking space in a source file is invisible
// and the next editor to touch this would "clean" it into a plain one.
const NBSP = '\u00A0';
const EN_SPACE = '\u2002';

describe('lookupKeys', () => {
  it('dedupes, drops blanks, and canonicalises', () => {
    expect(lookupKeys(['A-1', 'A-1', '', null, undefined, 'b-2']))
      .toEqual(['A1', 'B2']);
  });

  it('collapses the label spellings of one part to a single request key', () => {
    expect(lookupKeys(['M393A4K40DB3-CWE', 'P/N: M393A4K40DB3-CWE', 'm393a4k40db3 cwe',
                       'M393A4K40DB3_CWE']))
      .toEqual(['M393A4K40DB3CWE']);
  });

  it('is order-independent so an unchanged set does not refetch', () => {
    expect(lookupKeys(['B', 'A']).join(' ')).toBe(lookupKeys(['A', 'B']).join(' '));
  });

  it('returns nothing when there is nothing to look up', () => {
    expect(lookupKeys([null, '', undefined])).toEqual([]);
  });

  // A part number pasted out of a vendor PDF or spreadsheet routinely carries a
  // non-breaking space. The server canonicalises with an ASCII whitespace rule
  // (so its SQL twin can match), which leaves one standing — asking under a key
  // that dropped it means the answer comes back under a key nothing looks up.
  it('leaves the spaces the server keeps, so the request key is the answer key', () => {
    expect(lookupKeys([`p/n: m393a4k40db3${NBSP}-cwe`]))
      .toEqual([`M393A4K40DB3${NBSP}CWE`]);
    expect(lookupKeys([`a${EN_SPACE}1`])).toEqual([`A${EN_SPACE}1`]);
  });
});

describe('resolveMarket', () => {
  const values = new Map([['M393A4K40DB3CWE', VALUE]]);

  it('resolves the exact part number', () => {
    expect(resolveMarket(values, 'M393A4K40DB3-CWE', 0.3)?.maxBuy).toBe(63);
  });

  it('resolves the same part written the way a label prints it', () => {
    expect(resolveMarket(values, 'P/N: M393A4K40DB3-CWE', 0.3)?.maxBuy).toBe(63);
    expect(resolveMarket(values, ' m393a4k40db3-cwe ', 0.3)?.maxBuy).toBe(63);
    expect(resolveMarket(values, 'M393A4K40DB3_CWE', 0.3)?.maxBuy).toBe(63);
    expect(resolveMarket(values, 'm393a4k40db3 cwe', 0.3)?.maxBuy).toBe(63);
  });

  it('returns null for an unknown or blank part', () => {
    expect(resolveMarket(values, 'UNKNOWN', 0.3)).toBeNull();
    expect(resolveMarket(values, '', 0.3)).toBeNull();
    expect(resolveMarket(values, null, 0.3)).toBeNull();
  });

  it('resolves a row the server keyed under a non-ASCII space', () => {
    const served = new Map([[`M393A4K40DB3${NBSP}CWE`, VALUE]]);
    expect(resolveMarket(served, `p/n: m393a4k40db3${NBSP}-cwe`, 0.3)?.maxBuy).toBe(63);
  });

  // The server hands back a null maxBuy for any part it has only auto-tracked
  // at intake, so MarketAssist derives the ceiling itself — against the margin
  // the same response carried. Deriving it against a hardcoded 30% showed a
  // workspace on 40% one ceiling on the Market page and another in the PO
  // drawer, and the drawer's Use button wrote the wrong one into unitCost.
  it('carries the workspace target margin onto the resolved value', () => {
    expect(resolveMarket(values, 'M393A4K40DB3-CWE', 0.4)?.targetMargin).toBe(0.4);
    expect(resolveMarket(values, 'M393A4K40DB3-CWE', TARGET_MARGIN_FALLBACK)?.targetMargin)
      .toBe(0.3);
  });
});
