import { describe, it, expect } from 'vitest';
import { eligibleDraftTargets } from './eligibleTargets';
import type { OrderSummary } from '../../../lib/types';

const base: OrderSummary = {
  id: 'PO-1', userId: 'me', userName: 'Me', userInitials: 'ME',
  commissionRate: null, category: 'RAM', categories: ['RAM'], payment: 'company', notes: null,
  lifecycle: 'draft', archivedAt: null, createdAt: '2026-05-29T00:00:00Z',
  totalCost: 100, otherFees: 0, otherFeesNote: null,
  warehouse: null, qty: 0, revenue: 0, profit: 0,
  lineCount: 2, status: 'Draft',
};
const mk = (over: Partial<OrderSummary>): OrderSummary => ({ ...base, ...over });

describe('eligibleDraftTargets', () => {
  const opts = { meId: 'me', excludeId: 'PO-current' };

  it('returns the user’s own drafts, excluding the throwaway draft', () => {
    const orders = [
      mk({ id: 'PO-1' }),
      mk({ id: 'PO-current' }),               // the throwaway draft — excluded
      mk({ id: 'PO-2' }),
    ];
    expect(eligibleDraftTargets(orders, opts).map(o => o.id)).toEqual(['PO-1', 'PO-2']);
  });

  it('excludes other users and non-draft lifecycles', () => {
    const orders = [
      mk({ id: 'OTHER-USER', userId: 'someone' }),
      mk({ id: 'IN-TRANSIT', lifecycle: 'in_transit' }),
      mk({ id: 'KEEP' }),
    ];
    expect(eligibleDraftTargets(orders, opts).map(o => o.id)).toEqual(['KEEP']);
  });

  // A PO may mix categories, so an SSD draft is a valid home for RAM lines.
  it('includes drafts of any category', () => {
    const orders = [
      mk({ id: 'SSD-DRAFT', category: 'SSD', categories: ['SSD'] }),
      mk({ id: 'MIXED-DRAFT', category: 'Mixed', categories: ['RAM', 'HDD'] }),
      mk({ id: 'EMPTY-DRAFT', category: 'Mixed', categories: [] }),
    ];
    expect(eligibleDraftTargets(orders, opts).map(o => o.id))
      .toEqual(['SSD-DRAFT', 'MIXED-DRAFT', 'EMPTY-DRAFT']);
  });

  it('returns [] for empty input', () => {
    expect(eligibleDraftTargets([], opts)).toEqual([]);
  });

  it('returns [] when meId is undefined', () => {
    expect(eligibleDraftTargets([mk({})], { ...opts, meId: undefined })).toEqual([]);
  });
});
