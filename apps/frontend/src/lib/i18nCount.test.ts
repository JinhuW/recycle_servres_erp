import { describe, it, expect } from 'vitest';
import { I18N, countKey } from './i18n';

describe('countKey', () => {
  it('reads the singular for a count of one, where the table has one', () => {
    expect(countKey('acctBulkToast', { n: 1 })).toBe('acctBulkToastOne');
    expect(countKey('acctBulkToast', { n: 2 })).toBe('acctBulkToast');
    expect(countKey('acctBulkToast', { n: 0 })).toBe('acctBulkToast');
    // A count formatted for display still counts.
    expect(countKey('wxSumBuyers', { n: '1' })).toBe('wxSumBuyersOne');
    expect(countKey('wxSumBuyers', { n: '1,000' })).toBe('wxSumBuyers');
    expect(countKey('acctBulkToast')).toBe('acctBulkToast');
    expect(countKey('payStatusUnlinked', { n: 1 })).toBe('payStatusUnlinked');
  });

  it('leaves a singular that turns on another number to its caller', () => {
    // "1 of 5 entries": the count is the total, not n.
    expect(countKey('acctStripEntries', { n: 1, total: 5 })).toBe('acctStripEntries');
  });

  it('has every singular in both tables', () => {
    const singulars = Object.keys(I18N.en!).filter(k => k.endsWith('One') && I18N.en![k.slice(0, -3)] !== undefined);
    expect(singulars.length).toBeGreaterThan(10);
    for (const k of singulars) expect(I18N.en![k], k).toBeTruthy();
  });
});
