import { describe, it, expect } from 'vitest';
import { buildOrderSubmit } from './orderSubmit';
import type { DraftLine } from './types';

// The review screen's Submit lands on the order it just wrote, and reads the
// id off the draft when the request is a PATCH — so a patch must only ever be
// built for a session that has one.
const line: DraftLine = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', generation: 'DDR4',
  qty: 1, unitCost: 10, condition: 'New', label: 'Samsung 32GB DDR4',
};
const meta = {
  warehouseId: 'WH-LA1', payment: 'company' as const, paymentMethod: null,
  notes: '', otherFees: 0, otherFeesNote: null,
};

describe('buildOrderSubmit', () => {
  it('creates when the session never got a draft', () => {
    const r = buildOrderSubmit({ lines: [line] }, meta);
    expect(r.kind).toBe('create');
    expect(r.kind === 'create' && r.url).toBe('/api/orders');
  });

  it('patches the draft by id when one exists', () => {
    const r = buildOrderSubmit({ draftId: 'PO-1', lines: [line] }, meta);
    expect(r.kind).toBe('patch');
    expect(r.kind === 'patch' && r.url).toBe('/api/orders/PO-1');
  });
});
