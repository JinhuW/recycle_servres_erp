import { describe, it, expect } from 'vitest';
import { carriersOf, filterRows, flattenRows, previousSellers, rowsToCsv, statusCounts, type PoLabels, type ShipRow } from './shippingList';
import type { OrderSummary, Shipment } from './types';

function order(over: Partial<OrderSummary>): OrderSummary {
  return {
    id: 'PO-1', userId: 'u1', userName: 'Ada', userInitials: 'A', commissionRate: null,
    category: 'RAM', categories: [], payment: 'company', notes: null, lifecycle: 'draft',
    archivedAt: null, createdAt: '2026-08-01T00:00:00Z', totalCost: null, otherFees: 0,
    otherFeesNote: null, warehouse: null, qty: 0, revenue: 0, profit: 0, lineCount: 0, status: 'Draft',
    ...over,
  };
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

const sections: PoLabels[] = [
  {
    order: order({ id: 'PO-1', userName: 'Ada' }),
    shipments: [
      shipment({ id: 's1', status: 'in_transit', carrier: 'UPS', service: 'Ground', trackingNumber: '1Z999', createdAt: '2026-08-02T00:00:00Z', from: { ...shipment({}).from, name: 'Bo Li', city: 'Denver', state: 'CO' }, labelCost: 9.8 }),
      shipment({ id: 's2', status: 'draft', createdAt: '2026-08-05T00:00:00Z' }),
    ],
  },
  {
    order: order({ id: 'PO-2', userName: 'Kai' }),
    shipments: [
      shipment({ id: 's3', status: 'delivered', carrier: 'USPS', service: 'Priority', trackingNumber: '9400', createdAt: '2026-08-03T00:00:00Z' }),
    ],
  },
];

describe('flattenRows', () => {
  it('emits one row per shipment, newest first', () => {
    expect(flattenRows(sections).map(r => r.shipment.id)).toEqual(['s2', 's3', 's1']);
  });
});

describe('carriersOf', () => {
  it('lists distinct carriers, sorted, skipping unrated shipments', () => {
    expect(carriersOf(flattenRows(sections))).toEqual(['UPS', 'USPS']);
  });
});

describe('filterRows', () => {
  const rows = flattenRows(sections);
  const all = { status: 'all', carrier: 'all', search: '' } as const;

  it('passes everything through on the neutral filter', () => {
    expect(filterRows(rows, { ...all })).toHaveLength(3);
  });

  it('filters by status and carrier', () => {
    expect(filterRows(rows, { ...all, status: 'delivered' }).map(r => r.shipment.id)).toEqual(['s3']);
    expect(filterRows(rows, { ...all, carrier: 'UPS' }).map(r => r.shipment.id)).toEqual(['s1']);
  });

  it('searches order id, owner, seller name, and tracking number', () => {
    expect(filterRows(rows, { ...all, search: 'po-2' }).map(r => r.shipment.id)).toEqual(['s3']);
    expect(filterRows(rows, { ...all, search: 'ada' })).toHaveLength(2);
    expect(filterRows(rows, { ...all, search: 'bo li' }).map(r => r.shipment.id)).toEqual(['s1']);
    expect(filterRows(rows, { ...all, search: '1z9' }).map(r => r.shipment.id)).toEqual(['s1']);
    expect(filterRows(rows, { ...all, search: 'nothing' })).toHaveLength(0);
  });
});

describe('statusCounts', () => {
  it('counts per status plus the total', () => {
    const c = statusCounts(flattenRows(sections));
    expect(c.all).toBe(3);
    expect(c.draft).toBe(1);
    expect(c.in_transit).toBe(1);
    expect(c.delivered).toBe(1);
    expect(c.voided).toBe(0);
  });
});

describe('previousSellers', () => {
  const addr = (name: string, street1 = '1 Main St', zip = '80202') => ({
    name, phone: null, street1, street2: null, city: 'Denver', state: 'CO', zip, country: 'US',
  });

  it('lists complete seller addresses newest first, deduped', () => {
    const secs: PoLabels[] = [
      { order: order({ id: 'PO-1' }), shipments: [
        shipment({ id: 'a', from: addr('Ana'), createdAt: '2026-08-01T00:00:00Z' }),
        shipment({ id: 'b', from: addr('Bo'), createdAt: '2026-08-03T00:00:00Z' }),
        shipment({ id: 'c', from: addr('ANA'), createdAt: '2026-08-05T00:00:00Z' }), // dup of a (case-insensitive)
      ] },
    ];
    const out = previousSellers(secs);
    expect(out.map(p => p.from.name)).toEqual(['ANA', 'Bo']);
    expect(out[0].label).toBe('ANA · Denver, CO');
  });

  it('skips incomplete addresses (seller-fill shells)', () => {
    const secs: PoLabels[] = [
      { order: order({}), shipments: [shipment({ from: { ...shipment({}).from, name: 'NoStreet' } })] },
    ];
    expect(previousSellers(secs)).toEqual([]);
  });

  it('keeps sellers with the same name at different addresses separate', () => {
    const secs: PoLabels[] = [
      { order: order({}), shipments: [
        shipment({ id: 'a', from: addr('Ana', '1 Main St'), createdAt: '2026-08-02T00:00:00Z' }),
        shipment({ id: 'b', from: addr('Ana', '9 Elm St'), createdAt: '2026-08-01T00:00:00Z' }),
      ] },
    ];
    expect(previousSellers(secs)).toHaveLength(2);
  });
});

describe('rowsToCsv', () => {
  it('renders a header plus one line per row', () => {
    const csv = rowsToCsv(flattenRows(sections));
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('"Tracking #"');
    expect(csv).toContain('"1Z999"');
  });

  it('neutralises formula-leading cells', () => {
    const row: ShipRow = {
      order: order({ id: 'PO-9' }),
      shipment: shipment({ from: { ...shipment({}).from, name: '=cmd()' } }),
    };
    expect(rowsToCsv([row])).toContain('"\'=cmd()"');
  });
});
