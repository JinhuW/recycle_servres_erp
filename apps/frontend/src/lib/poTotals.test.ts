import { describe, it, expect } from 'vitest';
import { poEffectiveCost, parseFeeInput } from './poTotals';

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
