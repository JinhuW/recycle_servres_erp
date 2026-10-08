import { describe, it, expect } from 'vitest';
import { paymentGap, reviewApproveTotal } from './paymentGap';

describe('paymentGap', () => {
  it('is null when the bank paid the total to the cent', () => {
    expect(paymentGap(1279.8, 1279.8, 'company')).toBeNull();
  });

  it('flags a gap of a few cents', () => {
    expect(paymentGap(5835.25, 5835.28, 'company')).toEqual({ paid: 5835.25, total: 5835.28, diff: -0.03 });
  });

  it('signs the difference as paid minus total', () => {
    expect(paymentGap(2415, 70, 'company')?.diff).toBe(2345);
    expect(paymentGap(1665, 56053, 'company')?.diff).toBe(-54388);
  });

  it('ignores float noise below a cent', () => {
    expect(paymentGap(0.1 + 0.2, 0.3, 'company')).toBeNull();
  });

  it('is null when nothing is linked or the figure never arrived', () => {
    expect(paymentGap(null, 100, 'company')).toBeNull();
    expect(paymentGap(undefined, 100, 'company')).toBeNull();
  });

  it('flags a fully refunded payment', () => {
    expect(paymentGap(0, 100, 'company')).toEqual({ paid: 0, total: 100, diff: -100 });
  });

  // The bank money on a self-paid PO is the purchaser's reimbursement plus
  // their commission, which never equals the cost.
  it('is null on a self-paid PO', () => {
    expect(paymentGap(1500, 1000, 'self')).toBeNull();
  });
});

describe('reviewApproveTotal', () => {
  const lines = [
    { qty: 4, unitCost: 100 },
    { qty: 2, unitCost: 50 },
  ];
  const order = (o: { totalCost?: number | null; otherFees?: number; goodsFollowsLines?: boolean } = {}) => ({
    lines: lines as never,
    totalCost: o.totalCost === undefined ? 500 : o.totalCost,
    otherFees: o.otherFees ?? 0,
    goodsFollowsLines: o.goodsFollowsLines ?? true,
  });

  it('is the saved total when nothing is zeroed', () => {
    expect(reviewApproveTotal(order({ otherFees: 25 }), [])).toBe(525);
  });

  it('drops a goods total that follows the lines by the zeroed lines', () => {
    expect(reviewApproveTotal(order({ otherFees: 25 }), [lines[1]!])).toBe(425);
  });

  it('keeps a negotiated lot price', () => {
    expect(reviewApproveTotal(order({ totalCost: 450, goodsFollowsLines: false }), [lines[1]!])).toBe(450);
  });

  it('falls back to the line sum when no total is stored', () => {
    expect(reviewApproveTotal(order({ totalCost: null, otherFees: 10 }), [])).toBe(510);
  });
});
