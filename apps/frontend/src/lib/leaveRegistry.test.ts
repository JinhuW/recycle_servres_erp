import { describe, it, expect, afterEach } from 'vitest';
import { hasUnsavedChanges, registerHolder } from './leaveRegistry';

describe('hasUnsavedChanges', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  it('is false with nothing registered', () => {
    expect(hasUnsavedChanges()).toBe(false);
    expect(hasUnsavedChanges('/inventory')).toBe(false);
  });

  // The phone PO's info and products screens are one instance.
  it('lets a holder survive the routes it names', () => {
    cleanups.push(registerHolder((p) => p.startsWith('/purchase-orders/PO-1')));
    expect(hasUnsavedChanges('/purchase-orders/PO-1/products')).toBe(false);
    expect(hasUnsavedChanges('/purchase-orders/PO-2')).toBe(true);
    expect(hasUnsavedChanges()).toBe(true);
  });

  // A link may carry the page's own query; the route is the path.
  it('compares the path, not the query', () => {
    cleanups.push(registerHolder((p) => p === '/payments'));
    expect(hasUnsavedChanges('/payments?txn=abc')).toBe(false);
    expect(hasUnsavedChanges('#/payments?txn=abc')).toBe(false);
  });

  it('forgets a holder once it unregisters', () => {
    const off = registerHolder(() => false);
    expect(hasUnsavedChanges('/x')).toBe(true);
    off();
    expect(hasUnsavedChanges('/x')).toBe(false);
  });
});
