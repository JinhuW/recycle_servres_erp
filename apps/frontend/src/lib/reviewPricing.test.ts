import { describe, it, expect } from 'vitest';
import { lineMargin, parsePriceInput, reviewMoney, suggestedSell } from './reviewPricing';
import type { ResolvedMarketValue } from './useMarketLookup';

const market = (over: Partial<ResolvedMarketValue>): ResolvedMarketValue => ({
  partNumber: 'PN', label: 'PN', source: null, demand: 'medium',
  avgSell: null, lastPrice: null, lastPriceAt: null, lastPriceSource: null,
  maxBuy: null, target: null, low: null, high: null, samples: 0,
  updatedAt: '2026-10-01T00:00:00Z', internalSales: { avgPrice: null, samples: 0 },
  targetMargin: 0.3, ...over,
});

describe('suggestedSell', () => {
  it('prefers the last recorded price, then the average sell, then the team average', () => {
    expect(suggestedSell(market({ lastPrice: 42, avgSell: 40, internalSales: { avgPrice: 38, samples: 3 } })))
      .toEqual({ value: 42, basis: 'last' });
    expect(suggestedSell(market({ avgSell: 40, internalSales: { avgPrice: 38, samples: 3 } })))
      .toEqual({ value: 40, basis: 'avg' });
    expect(suggestedSell(market({ internalSales: { avgPrice: 38, samples: 3 } })))
      .toEqual({ value: 38, basis: 'internal' });
  });

  it('offers nothing for an unknown part, a zero price or a team average with no samples', () => {
    expect(suggestedSell(null)).toBeNull();
    expect(suggestedSell(market({ lastPrice: 0 }))).toBeNull();
    expect(suggestedSell(market({ internalSales: { avgPrice: 38, samples: 0 } }))).toBeNull();
  });
});

const lines = [
  { id: 'a', qty: 4, unitCost: 10, sellPrice: 25 },
  { id: 'b', qty: 2, unitCost: 30, sellPrice: null },
  { id: 'c', qty: 1, unitCost: 5, sellPrice: 8 },
];

describe('reviewMoney', () => {
  it('follows the Commission tab: revenue over priced lines, cost all-in, commission on the profit', () => {
    const m = reviewMoney({ lines, totalCost: null, otherFees: 7, commissionRate: 0.5, payment: 'company' });
    expect(m).toMatchObject({ priced: 2, total: 3, revenue: 108, goods: 105, fees: 7, cost: 112, lotPrice: false });
    expect(m.profit).toBe(-4);
    expect(m.commission).toBe(-2);
    expect(m.earns).toBe(-2);
  });

  it('pays the cost back on a self-paid PO', () => {
    const m = reviewMoney({ lines, totalCost: null, otherFees: 0, commissionRate: 0.4, payment: 'self' });
    expect(m.cost).toBe(105);
    expect(m.commission).toBeCloseTo(1.2);
    expect(m.earns).toBeCloseTo(106.2);
  });

  it('reads an unset rate as 0', () => {
    const m = reviewMoney({ lines, totalCost: null, otherFees: 0, commissionRate: null, payment: 'company' });
    expect(m.rate).toBe(0);
    expect(m.commission).toBe(0);
  });

  it('keeps a negotiated lot price as the goods cost, by the server verdict or by the mismatch', () => {
    const byVerdict = reviewMoney({ lines, totalCost: 90, goodsFollowsLines: false, otherFees: 0, commissionRate: 0.5, payment: 'company' });
    expect(byVerdict).toMatchObject({ goods: 90, lotPrice: true });
    const byMismatch = reviewMoney({ lines, totalCost: 90, otherFees: 0, commissionRate: 0.5, payment: 'company' });
    expect(byMismatch).toMatchObject({ goods: 90, lotPrice: true });
    // A stored total that mirrors the lines is not a lot price.
    const mirror = reviewMoney({ lines, totalCost: 105, otherFees: 0, commissionRate: 0.5, payment: 'company' });
    expect(mirror).toMatchObject({ goods: 105, lotPrice: false });
  });

  it('drops a line Approve will zero from the revenue, and from a goods total that follows the lines', () => {
    const zeroed = new Set(['a']);
    const follows = reviewMoney({ lines, totalCost: null, otherFees: 0, commissionRate: 0.5, payment: 'company', zeroed });
    expect(follows).toMatchObject({ revenue: 8, goods: 65, priced: 2 });
    const lot = reviewMoney({ lines, totalCost: 90, goodsFollowsLines: false, otherFees: 0, commissionRate: 0.5, payment: 'company', zeroed });
    expect(lot).toMatchObject({ revenue: 8, goods: 90 });
  });
});

describe('lineMargin', () => {
  it('is the margin on the sell price, negative below cost, null while unpriced', () => {
    expect(lineMargin(25, 10)).toBeCloseTo(0.6);
    expect(lineMargin(8, 10)).toBeCloseTo(-0.25);
    expect(lineMargin(null, 10)).toBeNull();
    expect(lineMargin(0, 10)).toBeNull();
  });
});

describe('parsePriceInput', () => {
  it('reads dollars with or without the sign and separators, to the cent', () => {
    expect(parsePriceInput('12.5')).toBe(12.5);
    expect(parsePriceInput(' $1,250.456 ')).toBe(1250.46);
    expect(parsePriceInput('0')).toBe(0);
  });

  it('clears on blank and refuses what is not a price', () => {
    expect(parsePriceInput('')).toBeNull();
    expect(parsePriceInput('  ')).toBeNull();
    expect(parsePriceInput('abc')).toBeUndefined();
    expect(parsePriceInput('-3')).toBeUndefined();
  });
});
