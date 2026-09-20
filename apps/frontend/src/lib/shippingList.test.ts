import { describe, it, expect } from 'vitest';
import {
  filterInbound, fmtEta, inboundCarriers, inboundCounts, inboundToCsv, mergeInbound,
  type ShipFilter,
} from './shippingList';
import type { TrackedPackage } from './packages';

function pkg(over: Partial<TrackedPackage>): TrackedPackage {
  return {
    id: 'p1', trackingNumber: '1Z999AA10123456784', carrier: 'UPS', status: 'in_transit',
    trackingEta: null, lastTrackedAt: null, sellerName: null, note: null,
    source: null, paypalTxnId: null, paymentScreenshotUrl: null, orderId: null,
    trackingUrl: null, creatorName: null, createdAt: '2026-08-04T00:00:00Z',
    ...over,
  };
}

const all: ShipFilter = { status: 'all', carrier: 'all', search: '' };

const pkgs: TrackedPackage[] = [
  pkg({ id: 'a', status: 'in_transit', carrier: 'UPS', createdAt: '2026-08-01T00:00:00Z' }),
  pkg({ id: 'b', status: 'delivered', carrier: 'USPS', trackingNumber: '9400123456789012', sellerName: 'Trench Corp', createdAt: '2026-08-03T00:00:00Z' }),
  pkg({ id: 'c', status: 'exception', carrier: 'FedEx', trackingNumber: '123456789012', orderId: 'PO-7', createdAt: '2026-08-02T00:00:00Z' }),
];

describe('fmtEta', () => {
  it('renders a date-only ETA as that calendar date, not the day before', () => {
    const s = fmtEta('2026-08-26', 'en-US');
    expect(s).toContain('26');
  });

  it('renders a UTC-midnight instant as its calendar date too', () => {
    expect(fmtEta('2026-08-26T00:00:00.000Z', 'en-US')).toContain('26');
  });

  it('returns null for nothing or garbage', () => {
    expect(fmtEta(null, 'en-US')).toBeNull();
    expect(fmtEta('not a date', 'en-US')).toBeNull();
  });
});

describe('mergeInbound', () => {
  it('orders packages newest first', () => {
    expect(mergeInbound(pkgs).map(r => r.pkg.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('filterInbound', () => {
  const merged = mergeInbound(pkgs);

  it('filters by status and carrier', () => {
    expect(filterInbound(merged, { ...all, status: 'delivered' }).map(r => r.pkg.id)).toEqual(['b']);
    expect(filterInbound(merged, { ...all, carrier: 'FedEx' }).map(r => r.pkg.id)).toEqual(['c']);
  });

  it('searches tracking numbers, seller names and the linked PO', () => {
    expect(filterInbound(merged, { ...all, search: 'trench' })).toHaveLength(1);
    expect(filterInbound(merged, { ...all, search: '123456789012' })).toHaveLength(2);
    expect(filterInbound(merged, { ...all, search: 'po-7' })).toHaveLength(1);
  });

  it('searches the package note — it renders on the row', () => {
    const withNote = mergeInbound([pkg({ note: 'fragile RAM sticks' })]);
    expect(filterInbound(withNote, { ...all, search: 'fragile' })).toHaveLength(1);
    expect(filterInbound(withNote, { ...all, search: 'absent' })).toHaveLength(0);
  });

  it('searches who submitted the package — it renders on the row', () => {
    const withCreator = mergeInbound([pkg({ creatorName: 'Bo Li' })]);
    expect(filterInbound(withCreator, { ...all, search: 'bo l' })).toHaveLength(1);
    expect(filterInbound(withCreator, { ...all, search: 'absent' })).toHaveLength(0);
  });

  it('searches the package PayPal transaction id — it renders on the row', () => {
    const withTxn = mergeInbound([pkg({ paypalTxnId: '9XY87654ZW321001Q' })]);
    expect(filterInbound(withTxn, { ...all, search: '9xy876' })).toHaveLength(1);
    expect(filterInbound(withTxn, { ...all, search: 'absent' })).toHaveLength(0);
  });

  it('searches the package source', () => {
    const withSource = mergeInbound([pkg({ source: 'reddit' })]);
    expect(filterInbound(withSource, { ...all, search: 'reddit' })).toHaveLength(1);
    expect(filterInbound(withSource, { ...all, search: 'facebook' })).toHaveLength(0);
  });
});

describe('inboundCounts and inboundCarriers', () => {
  const merged = mergeInbound(pkgs);

  it('counts packages into the status rail', () => {
    const c = inboundCounts(merged);
    expect(c.all).toBe(3);
    expect(c.delivered).toBe(1);
    expect(c.in_transit).toBe(1);
    expect(c.exception).toBe(1);
    expect(c.purchased).toBe(0);
  });

  it('lists carriers sorted and deduplicated', () => {
    expect(inboundCarriers(mergeInbound([...pkgs, pkg({ id: 'd', carrier: 'UPS' })]))).toEqual(['FedEx', 'UPS', 'USPS']);
  });
});

describe('inboundToCsv', () => {
  it('renders a header plus one line per row', () => {
    const csv = inboundToCsv(mergeInbound(pkgs));
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('"Tracking #"');
    expect(csv).toContain('"Trench Corp"');
    expect(csv).toContain('"1Z999AA10123456784"');
  });

  it('names who tracked each row', () => {
    const csv = inboundToCsv(mergeInbound([pkg({ creatorName: 'Kai' })]));
    expect(csv.split('\r\n')[0]).toContain('"Tracked by"');
    expect(csv).toContain('"Kai"');
  });

  it('carries the PayPal transaction id and the source', () => {
    const csv = inboundToCsv(mergeInbound([pkg({ paypalTxnId: '9XY87654ZW321001Q', source: 'facebook' })]));
    const [head, ...body] = csv.split('\r\n');
    expect(head).toContain('"PayPal txn"');
    expect(head.endsWith('"Source"')).toBe(true);
    expect(csv).toContain('"9XY87654ZW321001Q"');
    expect(body.some(l => l.endsWith('"facebook"'))).toBe(true);
  });

  it('neutralises formula-leading cells', () => {
    const csv = inboundToCsv(mergeInbound([pkg({ sellerName: '=cmd()', trackingNumber: '+123' })]));
    expect(csv).toContain('"\'=cmd()"');
    expect(csv).toContain('"\'+123"');
  });
});
