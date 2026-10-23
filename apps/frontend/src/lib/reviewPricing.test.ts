import { describe, it, expect } from 'vitest';
import {
  lineMargin, parsePriceInput, planSheet, reviewMoney, suggestedSell,
  type SheetCell, type SheetPreview,
} from './reviewPricing';
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
    const m = reviewMoney({ lines, totalCost: null, otherFees: 7, commissionRate: 0.5, selfReimbursed: false });
    expect(m).toMatchObject({ priced: 2, total: 3, revenue: 108, goods: 105, fees: 7, cost: 112, lotPrice: false });
    expect(m.profit).toBe(-4);
    expect(m.commission).toBe(-2);
    expect(m.earns).toBe(-2);
  });

  it('pays the cost back on a self-paid PO', () => {
    const m = reviewMoney({ lines, totalCost: null, otherFees: 0, commissionRate: 0.4, selfReimbursed: true });
    expect(m.cost).toBe(105);
    expect(m.commission).toBeCloseTo(1.2);
    expect(m.earns).toBeCloseTo(106.2);
  });

  it('reads an unset rate as 0', () => {
    const m = reviewMoney({ lines, totalCost: null, otherFees: 0, commissionRate: null, selfReimbursed: false });
    expect(m.rate).toBe(0);
    expect(m.commission).toBe(0);
  });

  it('keeps a negotiated lot price as the goods cost, by the server verdict or by the mismatch', () => {
    const byVerdict = reviewMoney({ lines, totalCost: 90, goodsFollowsLines: false, otherFees: 0, commissionRate: 0.5, selfReimbursed: false });
    expect(byVerdict).toMatchObject({ goods: 90, lotPrice: true });
    const byMismatch = reviewMoney({ lines, totalCost: 90, otherFees: 0, commissionRate: 0.5, selfReimbursed: false });
    expect(byMismatch).toMatchObject({ goods: 90, lotPrice: true });
    // A stored total that mirrors the lines is not a lot price.
    const mirror = reviewMoney({ lines, totalCost: 105, otherFees: 0, commissionRate: 0.5, selfReimbursed: false });
    expect(mirror).toMatchObject({ goods: 105, lotPrice: false });
  });

  it('drops a line Approve will zero from the revenue, and from a goods total that follows the lines', () => {
    const zeroed = new Set(['a']);
    const follows = reviewMoney({ lines, totalCost: null, otherFees: 0, commissionRate: 0.5, selfReimbursed: false, zeroed });
    expect(follows).toMatchObject({ revenue: 8, goods: 65, priced: 2 });
    const lot = reviewMoney({ lines, totalCost: 90, goodsFollowsLines: false, otherFees: 0, commissionRate: 0.5, selfReimbursed: false, zeroed });
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
    // A decimal comma is refused rather than read as thousands.
    expect(parsePriceInput('12,50')).toBeUndefined();
    expect(parsePriceInput('1,25')).toBeUndefined();
    expect(parsePriceInput('12,500')).toBe(12500);
    expect(parsePriceInput('-3')).toBeUndefined();
  });
});

describe('planSheet', () => {
  const cell = (rowNumber: number, price: number | null): SheetCell => ({
    sheet: 'Quote', rowNumber, rawPrice: String(price ?? ''), currency: 'USD', price,
  });
  const preview: SheetPreview = {
    fx: null,
    notOnPo: 2,
    lines: [
      { lineId: 'new', status: 'matched', cell: cell(3, 54.55) },
      { lineId: 'zero', status: 'matched', cell: cell(4, 20) },
      { lineId: 'diff', status: 'matched', cell: cell(5, 54.55) },
      { lineId: 'same', status: 'matched', cell: cell(6, 62.01) },
      { lineId: 'off', status: 'not-in-sheet' },
      { lineId: 'nopart', status: 'no-part' },
      { lineId: 'twice', status: 'conflict', cells: [cell(7, 188), cell(8, 205)] },
      { lineId: 'blank', status: 'no-price', cell: cell(9, null) },
    ],
  };
  const lines = [
    { id: 'new', sellPrice: null },
    // 0 is how a line is unpriced, so the sheet lands on it as on a blank.
    { id: 'zero', sellPrice: 0 },
    { id: 'diff', sellPrice: 52 },
    { id: 'same', sellPrice: 62.01 },
    { id: 'off', sellPrice: null },
    { id: 'nopart', sellPrice: null },
    { id: 'twice', sellPrice: null },
    { id: 'blank', sellPrice: 10 },
    // Added after the sheet was read: no match, no row.
    { id: 'later', sellPrice: null },
  ];

  it('lands on unpriced lines, reprices the rest and counts what it skips', () => {
    const p = planSheet(lines, preview, new Set());
    expect(p.writes).toEqual([
      { lineId: 'new', price: 54.55 },
      { lineId: 'zero', price: 20 },
      { lineId: 'diff', price: 54.55 },
    ]);
    expect(p.rows.get('new')).toMatchObject({ kind: 'in', price: 54.55 });
    expect(p.rows.get('diff')).toMatchObject({ kind: 'diff', price: 54.55, was: 52 });
    expect(p.rows.get('same')?.kind).toBe('same');
    expect(p.rows.get('off')?.kind).toBe('off');
    expect(p.rows.get('twice')).toMatchObject({ kind: 'skip', match: { status: 'conflict' } });
    expect(p.rows.has('later')).toBe(false);
    expect(p).toMatchObject({
      incoming: 2, repriced: 1, unchanged: 1, kept: 0, notInSheet: 1, unmatched: 3, notOnPo: 2,
    });
  });

  it('leaves a kept price out of the writes, and judges against the price as it stands now', () => {
    const p = planSheet(lines, preview, new Set(['diff']));
    expect(p.writes.map(w => w.lineId)).toEqual(['new', 'zero']);
    expect(p.rows.get('diff')).toMatchObject({ kind: 'kept', was: 52 });
    expect(p).toMatchObject({ repriced: 0, kept: 1 });

    // An unpriced line can be held too: it stays unpriced.
    const blank = planSheet(lines, preview, new Set(['new']));
    expect(blank.rows.get('new')).toMatchObject({ kind: 'kept', was: null });
    expect(blank.writes.map(w => w.lineId)).toEqual(['zero', 'diff']);
    expect(blank.incoming).toBe(1);

    // Typed to the sheet's figure after it was read: nothing left to write.
    const typed = planSheet(lines.map(l => (l.id === 'diff' ? { ...l, sellPrice: 54.55 } : l)), preview, new Set());
    expect(typed.rows.get('diff')?.kind).toBe('same');
    expect(typed.repriced).toBe(0);
  });
});
