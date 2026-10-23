import { describe, it, expect } from 'vitest';
import {
  BUSINESS_ACCOUNT, NO_WAREHOUSE, facetCounts, matchesPayment, matchesWarehouse,
  payerChoices, payerOptions, paymentKey, paymentPickOrAll, warehouseOptions,
} from './poFacets';

// A chip's number must be what its click shows; a wrong count here reads as
// a filter that "lost" POs.

const TIM = { id: 'u-tim', name: 'Tim' };
const JINHU = { id: 'u-jinhu', name: 'Jinhu' };

const po = (
  wh: string | null, payment: 'company' | 'self', paidBy: { id: string; name: string } | null = null, done = false,
) => ({
  warehouse: wh ? { id: wh, short: wh.toUpperCase() } : null,
  payment,
  paidBy,
  done,
});

const orders = [
  po('bos', 'company'),
  po('bos', 'self', TIM),
  po('den', 'company', null, true),
  po(null, 'self', JINHU),
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

describe('payers', () => {
  it('keys a PO by the Business Account or the person who paid', () => {
    expect(paymentKey(orders[0]!)).toBe(BUSINESS_ACCOUNT);
    expect(paymentKey(orders[1]!)).toBe('u-tim');
    // An older backend's self-paid row names nobody; it still has a chip.
    expect(paymentKey(po(null, 'self'))).toBe('self');
  });

  it('offers each payer seen, by name, the nameless self chip last', () => {
    expect(payerOptions([...orders, po('bos', 'self')])).toEqual([
      { id: 'u-jinhu', name: 'Jinhu' }, { id: 'u-tim', name: 'Tim' }, { id: 'self', name: null },
    ]);
    expect(payerOptions(orders.slice(0, 1))).toEqual([]);
  });

  it("reads a pick no loaded PO answers to as 'all'", () => {
    expect(paymentPickOrAll('u-tim', orders)).toBe('u-tim');
    expect(paymentPickOrAll('u-gone', orders)).toBe('all');
    expect(paymentPickOrAll('self', orders)).toBe('all');
    expect(paymentPickOrAll(BUSINESS_ACCOUNT, [])).toBe(BUSINESS_ACCOUNT);
  });

  it('offers the managers, then a non-manager owner, then a payer no longer listed', () => {
    const members = [
      { id: 'u-marcus', name: 'Marcus', role: 'purchaser' },
      { id: 'u-tim', name: 'Tim', role: 'manager' },
      { id: 'u-jinhu', name: 'Jinhu', role: 'manager' },
    ];
    const marcus = { id: 'u-marcus', name: 'Marcus' };
    expect(payerChoices(members, marcus, null).map(m => m.id)).toEqual(['u-tim', 'u-jinhu', 'u-marcus']);
    expect(payerChoices(members, TIM, null).map(m => m.id)).toEqual(['u-tim', 'u-jinhu']);
    const gone = { id: 'u-old', name: 'Old Manager' };
    expect(payerChoices(members, marcus, gone).map(m => m.id)).toEqual(['u-old', 'u-tim', 'u-jinhu', 'u-marcus']);
    expect(payerChoices(members, marcus, marcus).map(m => m.id)).toEqual(['u-tim', 'u-jinhu', 'u-marcus']);
  });
});

describe('matches', () => {
  it("'all' matches everything, 'none' matches a PO without a warehouse", () => {
    expect(matchesWarehouse(orders[3]!, 'all')).toBe(true);
    expect(matchesWarehouse(orders[3]!, NO_WAREHOUSE)).toBe(true);
    expect(matchesWarehouse(orders[0]!, NO_WAREHOUSE)).toBe(false);
    expect(matchesPayment(orders[0]!, 'u-tim')).toBe(false);
    expect(matchesPayment(orders[1]!, 'u-tim')).toBe(true);
    expect(matchesPayment(orders[0]!, BUSINESS_ACCOUNT)).toBe(true);
  });
});

describe('facetCounts', () => {
  it('counts each group with the other group applied but not itself', () => {
    const c = facetCounts(orders, { warehouse: 'bos', payment: 'u-tim' }, () => true);
    // Warehouse chips: payment=Tim applied → bos 1.
    expect(c.warehouse).toEqual({ bos: 1, all: 1 });
    // Payment chips: warehouse=bos applied → Business 1, Tim 1.
    expect(c.payment).toEqual({ all: 2, [BUSINESS_ACCOUNT]: 1, 'u-tim': 1 });
  });

  it('honours the downstream narrowing (Done prune, stage, Sold)', () => {
    const c = facetCounts(orders, { warehouse: 'all', payment: 'all' }, o => !o.done);
    expect(c.warehouse.den).toBeUndefined();
    expect(c.warehouse.all).toBe(3);
    expect(c.payment).toEqual({ all: 3, [BUSINESS_ACCOUNT]: 1, 'u-tim': 1, 'u-jinhu': 1 });
  });
});
