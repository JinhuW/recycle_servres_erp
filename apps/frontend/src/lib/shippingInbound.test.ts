import { describe, it, expect } from 'vitest';
import {
  canCreatePo, groupInbound, inboundAction, inboundSummary, journeyPos,
} from './shippingInbound';
import type { InboundRow } from './shippingList';
import type { TrackedPackage } from './packages';

function pkg(over: Partial<TrackedPackage>): TrackedPackage {
  return {
    id: 'p1', trackingNumber: '1Z999AA10123456784', carrier: 'UPS', status: 'in_transit',
    trackingEta: null, lastTrackedAt: null, sellerName: null, note: null,
    source: null, paypalTxnId: null, paymentScreenshotUrl: null, orderId: null,
    trackingUrl: null, creatorName: null, createdAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

const pkgRow = (p: Partial<TrackedPackage>): InboundRow => ({ kind: 'package', pkg: pkg(p) });

describe('inboundAction', () => {
  it('delivered package without a PO asks for one', () => {
    expect(inboundAction(pkgRow({ status: 'delivered' }))).toEqual({ kind: 'create-po' });
  });

  it('delivered package already linked to a PO needs nothing', () => {
    expect(inboundAction(pkgRow({ status: 'delivered', orderId: 'PO-9' }))).toBeNull();
  });

  it('a manager may create the PO before delivery — tracking-stall workaround', () => {
    expect(inboundAction(pkgRow({ status: 'purchased' }), true)).toEqual({ kind: 'create-po' });
    expect(inboundAction(pkgRow({ status: 'in_transit' }), true)).toEqual({ kind: 'create-po' });
    // Already linked: nothing to mint, manager or not.
    expect(inboundAction(pkgRow({ status: 'in_transit', orderId: 'PO-9' }), true)).toBeNull();
    // Non-managers still wait for delivery.
    expect(inboundAction(pkgRow({ status: 'in_transit' }), false)).toBeNull();
  });

  it('moving rows carry no action', () => {
    expect(inboundAction(pkgRow({ status: 'purchased' }))).toBeNull();
    expect(inboundAction(pkgRow({ status: 'in_transit' }))).toBeNull();
  });
});

describe('groupInbound', () => {
  it('splits rows into needs / moving / arrived', () => {
    const rows: InboundRow[] = [
      pkgRow({ id: 'a', status: 'in_transit' }),
      pkgRow({ id: 'b', status: 'delivered' }),
      pkgRow({ id: 'c', status: 'delivered', orderId: 'PO-3' }),
      pkgRow({ id: 'e', status: 'exception' }),
      pkgRow({ id: 'p1', status: 'purchased' }),
    ];
    const g = groupInbound(rows);
    expect(g.moving.map(rowId)).toEqual(['a', 'p1']);
    expect(g.needs.map(rowId)).toEqual(['e', 'b']);
    expect(g.arrived.map(rowId)).toEqual(['c']);
  });

  it('sorts moving rows by ETA, soonest first, unknown ETAs last', () => {
    const rows: InboundRow[] = [
      pkgRow({ id: 'late', status: 'in_transit', trackingEta: '2026-08-30' }),
      pkgRow({ id: 'none', status: 'in_transit', trackingEta: null }),
      pkgRow({ id: 'soon', status: 'in_transit', trackingEta: '2026-08-24' }),
    ];
    expect(groupInbound(rows).moving.map(rowId)).toEqual(['soon', 'late', 'none']);
  });

  it('orders needs by urgency: exception before create-po, newest first within', () => {
    const rows: InboundRow[] = [
      pkgRow({ id: 'old-po', status: 'delivered', createdAt: '2026-08-01T00:00:00Z' }),
      pkgRow({ id: 'new-po', status: 'delivered', createdAt: '2026-08-02T00:00:00Z' }),
      pkgRow({ id: 'exc', status: 'exception' }),
    ];
    expect(groupInbound(rows).needs.map(rowId)).toEqual(['exc', 'new-po', 'old-po']);
  });
});

describe('inboundSummary', () => {
  it('counts moving and needs-attention rows for the home card', () => {
    const rows: InboundRow[] = [
      pkgRow({ id: 'a', status: 'in_transit' }),
      pkgRow({ id: 'p1', status: 'purchased' }),
      pkgRow({ id: 'p2', status: 'delivered' }),
      pkgRow({ id: 'b', status: 'delivered', orderId: 'PO-9' }),
    ];
    expect(inboundSummary(rows)).toEqual({ moving: 2, needs: 1 });
  });
});

describe('journeyPos', () => {
  it('maps statuses onto the 4-step strip', () => {
    expect(journeyPos(pkgRow({ status: 'purchased' }))).toBe(1);
    expect(journeyPos(pkgRow({ status: 'in_transit' }))).toBe(2);
    expect(journeyPos(pkgRow({ status: 'exception' }))).toBe(2);
    expect(journeyPos(pkgRow({ status: 'delivered' }))).toBe(3);
  });
});

function rowId(r: InboundRow): string {
  return r.pkg.id;
}

describe('shared row predicates (desktop CTAs use these too)', () => {
  it('canCreatePo: delivered for everyone, any status for managers, never once linked', () => {
    expect(canCreatePo(pkg({ status: 'delivered' }), false)).toBe(true);
    expect(canCreatePo(pkg({ status: 'in_transit' }), false)).toBe(false);
    expect(canCreatePo(pkg({ status: 'in_transit' }), true)).toBe(true);
    expect(canCreatePo(pkg({ status: 'delivered', orderId: 'PO-9' }), true)).toBe(false);
  });
});
