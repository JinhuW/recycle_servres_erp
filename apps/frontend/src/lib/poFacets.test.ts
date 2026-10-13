import { describe, it, expect } from 'vitest';
import { NO_WAREHOUSE, facetCounts, matchesPayment, matchesWarehouse, warehouseOptions } from './poFacets';

// A chip's number must be what its click shows; a wrong count here reads as
// a filter that "lost" POs.

const po = (wh: string | null, payment: 'company' | 'self', done = false) => ({
  warehouse: wh ? { id: wh, short: wh.toUpperCase() } : null,
  payment,
  done,
});

const orders = [
  po('bos', 'company'),
  po('bos', 'self'),
  po('den', 'company', true),
  po(null, 'self'),
];

describe('warehouseOptions', () => {
  it('lists each warehouse once, by short code, with No warehouse last', () => {
    expect(warehouseOptions(orders)).toEqual([
      { id: 'bos', short: 'BOS' },
      { id: 'den', short: 'DEN' },
      { id: NO_WAREHOUSE, short: '' },
    ]);
  });

  it('omits the No-warehouse entry when every PO has one', () => {
    expect(warehouseOptions(orders.slice(0, 3)).map(w => w.id)).toEqual(['bos', 'den']);
  });
});

describe('matches', () => {
  it("'all' matches everything, 'none' matches a PO without a warehouse", () => {
    expect(matchesWarehouse(orders[3], 'all')).toBe(true);
    expect(matchesWarehouse(orders[3], NO_WAREHOUSE)).toBe(true);
    expect(matchesWarehouse(orders[0], NO_WAREHOUSE)).toBe(false);
    expect(matchesPayment(orders[0], 'self')).toBe(false);
    expect(matchesPayment(orders[1], 'self')).toBe(true);
  });
});

describe('facetCounts', () => {
  it('counts each group with the other group applied but not itself', () => {
    const c = facetCounts(orders, { warehouse: 'bos', payment: 'self' }, () => true);
    // Warehouse chips: payment=self applied → bos 1, none 1.
    expect(c.warehouse).toEqual({ bos: 1, [NO_WAREHOUSE]: 1, all: 2 });
    // Payment chips: warehouse=bos applied → company 1, self 1.
    expect(c.payment).toEqual({ all: 2, company: 1, self: 1 });
  });

  it('honours the downstream narrowing (Done prune, stage, Sold)', () => {
    const c = facetCounts(orders, { warehouse: 'all', payment: 'all' }, o => !o.done);
    expect(c.warehouse.den).toBeUndefined();
    expect(c.warehouse.all).toBe(3);
    expect(c.payment).toEqual({ all: 3, company: 1, self: 2 });
  });
});
