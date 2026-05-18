import { describe, it, expect } from 'vitest';
import { vendorTokenFromPath, basketTotal, type BasketLine } from '../src/lib/vendor';

describe('vendor helpers', () => {
  it('extracts the token from a /v/<token> path', () => {
    expect(vendorTokenFromPath('/v/abc123')).toBe('abc123');
    expect(vendorTokenFromPath('/v/abc123/anything')).toBe('abc123');
    expect(vendorTokenFromPath('/dashboard')).toBeNull();
    expect(vendorTokenFromPath('/v/')).toBeNull();
  });

  it('sums basket line totals', () => {
    const b: BasketLine[] = [
      { inventoryId: '1', label: 'A', qty: 2, unitPrice: 5, available: 10, category: 'RAM' },
      { inventoryId: '2', label: 'B', qty: 3, unitPrice: 4, available: 9, category: 'SSD' },
    ];
    expect(basketTotal(b)).toBe(22);
  });
});
