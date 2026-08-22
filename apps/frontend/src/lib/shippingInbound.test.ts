import { describe, it, expect } from 'vitest';
import {
  groupInbound, inboundAction, inboundSummary, journeyPos,
} from './shippingInbound';
import type { InboundRow, ShipOrder } from './shippingList';
import type { TrackedPackage } from './packages';
import type { Shipment } from './types';

function order(over: Partial<ShipOrder>): ShipOrder {
  return { id: 'PO-1', userName: 'Ada', lifecycle: 'confirmed', warehouse: null, ...over };
}

function shipment(over: Partial<Shipment>): Shipment {
  return {
    id: 's1', orderId: 'PO-1', status: 'draft',
    from: { name: null, phone: null, street1: null, street2: null, city: null, state: null, zip: null, country: null },
    package: { weightOz: null, lengthIn: null, widthIn: null, heightIn: null },
    carrier: null, service: null, rateAmount: null, rateCurrency: 'USD', deliveryDays: null,
    provider: 'stub', trackingNumber: null, trackingUrl: null, labelUrl: null, labelCost: null,
    trackingStatus: null, trackingEta: null, lastTrackedAt: null, sellerToken: null,
    complete: false, createdBy: null, createdAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

function pkg(over: Partial<TrackedPackage>): TrackedPackage {
  return {
    id: 'p1', trackingNumber: '1Z999AA10123456784', carrier: 'UPS', status: 'in_transit',
    trackingEta: null, lastTrackedAt: null, sellerName: null, note: null, orderId: null,
    createdAt: '2026-08-01T00:00:00Z',
    ...over,
  };
}

const shipRow = (o: Partial<ShipOrder>, s: Partial<Shipment>): InboundRow =>
  ({ kind: 'shipment', order: order(o), shipment: shipment(s) });
const pkgRow = (p: Partial<TrackedPackage>): InboundRow => ({ kind: 'package', pkg: pkg(p) });

describe('inboundAction', () => {
  it('delivered package without a PO asks for one', () => {
    expect(inboundAction(pkgRow({ status: 'delivered' }))).toEqual({ kind: 'create-po' });
  });

  it('delivered package already linked to a PO needs nothing', () => {
    expect(inboundAction(pkgRow({ status: 'delivered', orderId: 'PO-9' }))).toBeNull();
  });

  it('delivered shipment on an unfinished PO asks to complete it', () => {
    expect(inboundAction(shipRow({ id: 'PO-3', lifecycle: 'in_transit' }, { status: 'delivered' })))
      .toEqual({ kind: 'complete-po', orderId: 'PO-3' });
  });

  it('delivered shipment on a done PO needs nothing', () => {
    expect(inboundAction(shipRow({ lifecycle: 'done' }, { status: 'delivered' }))).toBeNull();
  });

  it('waiting-on-seller shipment offers the link again', () => {
    expect(inboundAction(shipRow({ id: 'PO-4' }, { id: 's9', status: 'draft', sellerToken: 'tok1' })))
      .toEqual({ kind: 'reshare-link', orderId: 'PO-4', sid: 's9', token: 'tok1' });
  });

  it('seller-filled shipment points at the desktop buy step', () => {
    expect(inboundAction(shipRow({}, { status: 'quoted', sellerToken: 'tok1', complete: true })))
      .toEqual({ kind: 'buy-desktop' });
  });

  it('a manually started draft points at the desktop wizard', () => {
    expect(inboundAction(shipRow({}, { status: 'draft' }))).toEqual({ kind: 'finish-desktop' });
  });

  it('moving and voided rows carry no action', () => {
    expect(inboundAction(shipRow({}, { status: 'in_transit' }))).toBeNull();
    expect(inboundAction(shipRow({}, { status: 'voided' }))).toBeNull();
    expect(inboundAction(pkgRow({ status: 'purchased' }))).toBeNull();
  });
});

describe('groupInbound', () => {
  it('splits rows into needs / moving / arrived / voided', () => {
    const rows: InboundRow[] = [
      shipRow({ id: 'PO-1' }, { id: 'a', status: 'in_transit' }),
      shipRow({ id: 'PO-2', lifecycle: 'in_transit' }, { id: 'b', status: 'delivered' }),
      shipRow({ id: 'PO-3', lifecycle: 'done' }, { id: 'c', status: 'delivered' }),
      shipRow({ id: 'PO-4' }, { id: 'd', status: 'voided' }),
      shipRow({ id: 'PO-5' }, { id: 'e', status: 'exception' }),
      pkgRow({ id: 'p1', status: 'purchased' }),
      pkgRow({ id: 'p2', status: 'delivered' }),
    ];
    const g = groupInbound(rows);
    expect(g.moving.map(rowId)).toEqual(['a', 'p1']);
    expect(g.needs.map(rowId)).toEqual(['e', 'p2', 'b']);
    expect(g.arrived.map(rowId)).toEqual(['c']);
    expect(g.voided.map(rowId)).toEqual(['d']);
  });

  it('sorts moving rows by ETA, soonest first, unknown ETAs last', () => {
    const rows: InboundRow[] = [
      pkgRow({ id: 'late', status: 'in_transit', trackingEta: '2026-08-30' }),
      pkgRow({ id: 'none', status: 'in_transit', trackingEta: null }),
      pkgRow({ id: 'soon', status: 'in_transit', trackingEta: '2026-08-24' }),
    ];
    expect(groupInbound(rows).moving.map(rowId)).toEqual(['soon', 'late', 'none']);
  });

  it('orders needs by urgency: exception, create-po, complete-po, then desktop handoffs', () => {
    const rows: InboundRow[] = [
      shipRow({ id: 'PO-1' }, { id: 'wait', status: 'draft', sellerToken: 'tk' }),
      shipRow({ id: 'PO-2' }, { id: 'filled', status: 'quoted', sellerToken: 'tk', complete: true }),
      shipRow({ id: 'PO-3', lifecycle: 'in_transit' }, { id: 'done-po', status: 'delivered' }),
      pkgRow({ id: 'no-po', status: 'delivered' }),
      shipRow({ id: 'PO-4' }, { id: 'exc', status: 'exception' }),
    ];
    expect(groupInbound(rows).needs.map(rowId)).toEqual(['exc', 'no-po', 'done-po', 'filled', 'wait']);
  });
});

describe('inboundSummary', () => {
  it('counts moving and needs-attention rows for the home card', () => {
    const rows: InboundRow[] = [
      shipRow({}, { id: 'a', status: 'in_transit' }),
      pkgRow({ id: 'p1', status: 'purchased' }),
      pkgRow({ id: 'p2', status: 'delivered' }),
      shipRow({ lifecycle: 'done' }, { id: 'b', status: 'delivered' }),
      shipRow({}, { id: 'c', status: 'voided' }),
    ];
    expect(inboundSummary(rows)).toEqual({ moving: 2, needs: 1 });
  });
});

describe('journeyPos', () => {
  it('maps statuses onto the 4-step strip', () => {
    expect(journeyPos(shipRow({}, { status: 'draft' }))).toBe(0);
    expect(journeyPos(shipRow({}, { status: 'quoted' }))).toBe(0);
    expect(journeyPos(shipRow({}, { status: 'purchased' }))).toBe(1);
    expect(journeyPos(pkgRow({ status: 'in_transit' }))).toBe(2);
    expect(journeyPos(pkgRow({ status: 'exception' }))).toBe(2);
    expect(journeyPos(shipRow({}, { status: 'delivered' }))).toBe(3);
  });
});

function rowId(r: InboundRow): string {
  return r.kind === 'package' ? r.pkg.id : r.shipment.id;
}
