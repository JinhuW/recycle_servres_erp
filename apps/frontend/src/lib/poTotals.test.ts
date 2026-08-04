import { describe, it, expect } from 'vitest';
import { poEffectiveCost, parseFeeInput, splitGoodsOverflow } from './poTotals';

describe('poEffectiveCost', () => {
  it('uses the line subtotal when there is no override', () => {
    expect(poEffectiveCost({ lineSubtotal: 1200 })).toEqual({ goods: 1200, fees: 0, total: 1200 });
  });

  it('adds fees on top of the line subtotal', () => {
    expect(poEffectiveCost({ lineSubtotal: 1200, otherFees: 79.8 }))
      .toEqual({ goods: 1200, fees: 79.8, total: 1279.8 });
  });

  // The override replaces the goods figure only. A fee charged on top of a
  // negotiated lot price must still be added, not absorbed by it.
  it('adds fees on top of the override, not inside it', () => {
    expect(poEffectiveCost({ lineSubtotal: 1200, totalCostOverride: 900, otherFees: 50 }))
      .toEqual({ goods: 900, fees: 50, total: 950 });
  });

  it('treats a zero override as a real override, not as absent', () => {
    expect(poEffectiveCost({ lineSubtotal: 1200, totalCostOverride: 0, otherFees: 25 }))
      .toEqual({ goods: 0, fees: 25, total: 25 });
  });

  it('treats null/undefined money as zero', () => {
    expect(poEffectiveCost({ lineSubtotal: 500, totalCostOverride: null, otherFees: null }))
      .toEqual({ goods: 500, fees: 0, total: 500 });
  });

  it('survives a NaN subtotal rather than propagating it into the total', () => {
    expect(poEffectiveCost({ lineSubtotal: Number.NaN, otherFees: 10 }))
      .toEqual({ goods: 0, fees: 10, total: 10 });
  });
});

describe('parseFeeInput', () => {
  it('reads a plain amount', () => {
    expect(parseFeeInput('79.80')).toBe(79.8);
    expect(parseFeeInput('  12 ')).toBe(12);
  });

  // These are states a number input passes through while someone types. None
  // may reach a total as NaN.
  it('reads blank and half-typed input as no fee', () => {
    for (const raw of ['', '   ', '5e', '-', 'abc', 'NaN']) {
      expect(parseFeeInput(raw), `input ${JSON.stringify(raw)}`).toBe(0);
    }
  });

  it('reads a negative or zero amount as no fee', () => {
    expect(parseFeeInput('-20')).toBe(0);
    expect(parseFeeInput('0')).toBe(0);
  });
});

describe('splitGoodsOverflow', () => {
  const LINES = 11530.50;

  it('moves the excess over the line sum out of goods', () => {
    expect(splitGoodsOverflow(11610.30, LINES)).toEqual({ goods: LINES, overflow: 79.80 });
  });

  // 11610.30 - 11530.50 is 79.80000000000018 unrounded, which would read as
  // dust in the input and travel to a NUMERIC(12,2) column.
  it('rounds the overflow to cents rather than leaking float dust', () => {
    const { overflow } = splitGoodsOverflow(11610.30, LINES);
    expect(overflow).toBe(79.80);
    expect(String(overflow)).toBe('79.8');
  });

  // A total below the line sum is a negotiated lot discount. It has to stay in
  // goods — the DB rejects a negative fee.
  it('leaves a total below the line sum alone', () => {
    expect(splitGoodsOverflow(11000, LINES)).toEqual({ goods: 11000, overflow: 0 });
  });

  it('does not move an equal total, or one within a cent', () => {
    expect(splitGoodsOverflow(LINES, LINES).overflow).toBe(0);
    expect(splitGoodsOverflow(LINES + 0.009, LINES).overflow).toBe(0);
    // Just past the epsilon it does move.
    expect(splitGoodsOverflow(LINES + 0.02, LINES).overflow).toBe(0.02);
  });

  it('leaves non-finite input alone', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(splitGoodsOverflow(v, LINES).overflow, `typed ${v}`).toBe(0);
    }
    expect(splitGoodsOverflow(500, Number.NaN).overflow).toBe(0);
  });

  it('treats a zero or blank-parsed total as no move', () => {
    expect(splitGoodsOverflow(0, LINES)).toEqual({ goods: 0, overflow: 0 });
  });

  // The invariant that makes the move safe: the caller ADDS the overflow to any
  // existing fee, so the all-in total is identical before and after.
  it('keeps the all-in total unchanged when applied on top of an existing fee', () => {
    const feesBefore = 20;
    const typed = 11610.30;
    const totalBefore = typed + feesBefore;

    const { goods, overflow } = splitGoodsOverflow(typed, LINES);
    const feesAfter = feesBefore + overflow;

    expect(feesAfter).toBe(99.80);
    expect(goods + feesAfter).toBeCloseTo(totalBefore, 2);
  });
});
