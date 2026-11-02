import { describe, it, expect } from 'vitest';
import { recordMismatch } from '@recycle-erp/shared';

describe('recordMismatch', () => {
  it('flags a book total more than 2% off the record, either way', () => {
    expect(recordMismatch({ amount: 1000, currency: 'USD' }, 7000, 7)).toBeNull();
    expect(recordMismatch({ amount: 1000, currency: 'USD' }, 7140, 7)).toBeNull();
    expect(recordMismatch({ amount: 1000, currency: 'USD' }, 7141, 7)).toMatchObject({ figureCny: 7000, recordedCny: 7141 });
    expect(recordMismatch({ amount: 1000, currency: 'USD' }, 6859, 7)?.pct).toBeCloseTo(-0.0201, 4);
    expect(recordMismatch({ amount: 500, currency: 'CNY' }, 0, null)).toMatchObject({ figureCny: 500, pct: -1 });
  });

  it('never flags a record with no figure or no rate', () => {
    expect(recordMismatch(null, 100, 7)).toBeNull();
    expect(recordMismatch({ amount: null, currency: 'USD' }, 100, 7)).toBeNull();
    expect(recordMismatch({ amount: 0, currency: 'USD' }, 100, 7)).toBeNull();
    expect(recordMismatch({ amount: 100, currency: 'USD' }, 100, null)).toBeNull();
  });
});
