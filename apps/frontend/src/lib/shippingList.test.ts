import { describe, it, expect } from 'vitest';
import {
  carriersOf, filterRows, flattenRows, fmtEta, inboundCarriers, inboundCounts, inboundToCsv,
  matchSellers, mergeInbound, filterInbound, rowsToCsv, statusCounts,
  type PoLabels, type PrevSeller, type ShipRow,
} from './shippingList';
import type { TrackedPackage } from './packages';
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

describe('fmtEta', () => {
  it('returns null for missing or unparseable input', () => {
    expect(fmtEta(null, 'en-US')).toBeNull();
    expect(fmtEta('not-a-date', 'en-US')).toBeNull();
  });

  it('renders date-only ETAs as that calendar date, not the local-time previous day', () => {
    expect(fmtEta('2026-08-25', 'en-US')).toBe('Tue, Aug 25');
  });

  it('treats a UTC-midnight round trip through the DB as date-only', () => {
    expect(fmtEta('2026-08-25T00:00:00.000Z', 'en-US')).toBe('Tue, Aug 25');
    expect(fmtEta('2026-08-25T00:00:00Z', 'en-US')).toBe('Tue, Aug 25');
  });

  it('still formats real instants', () => {
    expect(fmtEta('2026-08-25T15:30:00Z', 'en-US')).toBeTruthy();
  });
});

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

describe('matchSellers', () => {
  const mk = (names: string[]): PrevSeller[] =>
    names.map((name, i) => ({
      key: `${name.toLowerCase()}|1 main st|80202`,
      label: `${name} · Denver, CO`,
      from: {
        name, phone: null, street1: '1 Main St', street2: null,
        city: 'Denver', state: 'CO', zip: '80202', country: 'US',
      },
      count: 1,
      lastUsed: `2026-08-0${(i % 9) + 1}T00:00:00Z`,
    }));

  it('ranks prefix matches above substring matches', () => {
    const list = mk(['Wang Jin', 'Jinhu Wang', 'Bo Li']);
    expect(matchSellers(list, 'jin').map(p => p.from.name)).toEqual(['Jinhu Wang', 'Wang Jin']);
  });

  it('returns nothing for an empty query and caps at 6', () => {
    const list = mk(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7']);
    expect(matchSellers(list, '')).toEqual([]);
    expect(matchSellers(list, 'a')).toHaveLength(6);
  });
});

function pkg(over: Partial<TrackedPackage>): TrackedPackage {
  return {
    id: 'p1', trackingNumber: '1Z999AA10123456784', carrier: 'UPS', status: 'in_transit',
    trackingEta: null, lastTrackedAt: null, sellerName: null, note: null, orderId: null,
    createdAt: '2026-08-04T00:00:00Z',
    ...over,
  };
}

describe('mergeInbound', () => {
  it('interleaves shipments and packages newest first', () => {
    const rows = mergeInbound(flattenRows(sections), [pkg({ id: 'p1', createdAt: '2026-08-04T00:00:00Z' })]);
    expect(rows.map(r => (r.kind === 'package' ? r.pkg.id : r.shipment.id))).toEqual(['s2', 'p1', 's3', 's1']);
  });
});

describe('filterInbound', () => {
  const all = { status: 'all', carrier: 'all', search: '' } as const;
  const rows = mergeInbound(flattenRows(sections), [
    pkg({ id: 'p1', status: 'delivered', carrier: 'FedEx', trackingNumber: '123456789012', sellerName: 'Trench Corp' }),
  ]);

  it('filters packages by status and carrier alongside shipments', () => {
    expect(filterInbound(rows, { ...all, status: 'delivered' })).toHaveLength(2);
    expect(filterInbound(rows, { ...all, carrier: 'FedEx' }).map(r => r.kind)).toEqual(['package']);
  });

  it('searches package tracking numbers and seller names', () => {
    expect(filterInbound(rows, { ...all, search: 'trench' })).toHaveLength(1);
    expect(filterInbound(rows, { ...all, search: '123456789012' })).toHaveLength(1);
  });

  it('searches the package note — it renders on the row', () => {
    const withNote = mergeInbound([], [pkg({ note: 'fragile RAM sticks' })]);
    expect(filterInbound(withNote, { ...all, search: 'fragile' })).toHaveLength(1);
    expect(filterInbound(withNote, { ...all, search: 'absent' })).toHaveLength(0);
  });
});

describe('inboundCounts and inboundCarriers', () => {
  const rows = mergeInbound(flattenRows(sections), [pkg({ status: 'delivered', carrier: 'FedEx' })]);

  it('counts packages into the same status rail', () => {
    const c = inboundCounts(rows);
    expect(c.all).toBe(4);
    expect(c.delivered).toBe(2);
  });

  it('includes package carriers', () => {
    expect(inboundCarriers(rows)).toEqual(['FedEx', 'UPS', 'USPS']);
  });
});

describe('inboundToCsv', () => {
  it('exports package rows with empty order columns', () => {
    const csv = inboundToCsv(mergeInbound(flattenRows(sections), [pkg({ sellerName: 'Trench Corp' })]));
    expect(csv.split('\r\n')).toHaveLength(5);
    expect(csv).toContain('"Trench Corp"');
    expect(csv).toContain('"1Z999AA10123456784"');
  });

  it('neutralises formula-leading package cells too', () => {
    const csv = inboundToCsv(mergeInbound([], [pkg({ sellerName: '=cmd()', trackingNumber: '+123' })]));
    expect(csv).toContain('"\'=cmd()"');
    expect(csv).toContain('"\'+123"');
  });

  it('quotes embedded quotes and newlines', () => {
    const csv = inboundToCsv(mergeInbound([], [pkg({ sellerName: 'Acme "Deals"\r\nLLC' })]));
    expect(csv).toContain('"Acme ""Deals""\r\nLLC"');
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
