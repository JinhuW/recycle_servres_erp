import { describe, it, expect } from 'vitest';
import type { EbayLineItem, EbayOrder } from '../src/ebay/client';
import { matchOrders, type ListingLookup } from '../src/ebay/match';

const usd = (value: string) => ({ value, currency: 'USD' });

function line(over: Partial<EbayLineItem> & { lineItemId: string }): EbayLineItem {
  return {
    legacyItemId: '000',
    quantity: 1,
    lineItemCost: usd('10.00'),
    total: usd('10.00'),
    ...over,
  };
}

function order(over: Partial<EbayOrder> & { lineItems: EbayLineItem[] }): EbayOrder {
  return {
    orderId: '01-00001-00001',
    creationDate: '2026-11-20T15:04:05.000Z',
    lastModifiedDate: '2026-11-21T09:00:00.000Z',
    orderFulfillmentStatus: 'NOT_STARTED',
    orderPaymentStatus: 'PAID',
    cancelStatus: { cancelState: 'NONE_REQUESTED' },
    buyer: { username: 'ram_buyer' },
    totalMarketplaceFee: usd('0.00'),
    ...over,
  };
}

const lookup: ListingLookup = {
  bySku: new Map([['RS-EB-1', 1], ['RS-EB-2', 2]]),
  byItemId: new Map([['335500000001', 1], ['335500000009', 9]]),
};

describe('matchOrders', () => {
  it('matches by sku and reports price, qty, buyer and date', () => {
    const [c, ...rest] = matchOrders([order({
      totalMarketplaceFee: usd('17.85'),
      lineItems: [line({
        lineItemId: '10001', sku: 'RS-EB-1', legacyItemId: '335500000001', quantity: 3,
        lineItemCost: usd('269.97'), total: usd('290.00'),
      })],
    })], lookup);
    expect(rest).toEqual([]);
    expect(c).toEqual({
      listingId: 1,
      ebayOrderId: '01-00001-00001',
      ebayLineItemId: '10001',
      qty: 3,
      unitPrice: 89.99,
      fees: 17.85,
      buyer: 'ram_buyer',
      soldAt: new Date('2026-11-20T15:04:05.000Z'),
      cancelled: false,
    });
  });

  it('falls back to the eBay item number for a listing linked by hand', () => {
    const got = matchOrders([order({
      lineItems: [line({ lineItemId: '1', legacyItemId: '335500000009' })],
    }), order({
      orderId: 'o2',
      // A SKU the ERP never issued still matches by item number.
      lineItems: [line({ lineItemId: '2', sku: 'SELLER-OWN', legacyItemId: '335500000009' })],
    })], lookup);
    expect(got.map((c) => [c.ebayOrderId, c.listingId])).toEqual([['01-00001-00001', 9], ['o2', 9]]);
  });

  it('prefers the sku over the item number', () => {
    const [c] = matchOrders([order({
      lineItems: [line({ lineItemId: '1', sku: 'RS-EB-2', legacyItemId: '335500000001' })],
    })], lookup);
    expect(c.listingId).toBe(2);
  });

  it('apportions the fee by line total and skips unmatched lines', () => {
    const got = matchOrders([order({
      totalMarketplaceFee: usd('10.00'),
      lineItems: [
        line({ lineItemId: 'a', sku: 'RS-EB-1', total: usd('100.00'), lineItemCost: usd('100.00') }),
        line({ lineItemId: 'b', sku: 'NOT-OURS', legacyItemId: '999', total: usd('100.00') }),
        line({ lineItemId: 'c', sku: 'RS-EB-2', quantity: 2, total: usd('100.00'), lineItemCost: usd('90.00') }),
      ],
    })], lookup);
    expect(got.map((c) => c.ebayLineItemId)).toEqual(['a', 'c']);
    // 10.00 / 3 = 3.333…: whole cents adding back to the total, the odd cent to the first line.
    expect(got.map((c) => c.fees)).toEqual([3.34, 3.33]);
    expect(got[1]).toMatchObject({ qty: 2, unitPrice: 45 });
  });

  it('splits the fee in proportion to unequal totals', () => {
    const got = matchOrders([order({
      totalMarketplaceFee: usd('12.99'),
      lineItems: [
        line({ lineItemId: 'a', sku: 'RS-EB-1', total: usd('300.00') }),
        line({ lineItemId: 'b', sku: 'RS-EB-2', total: usd('100.00') }),
      ],
    })], lookup);
    expect(got.map((c) => c.fees)).toEqual([9.74, 3.25]);
    expect(Math.round(got.reduce((s, c) => s + c.fees, 0) * 100)).toBe(1299);
  });

  it('flags cancelled orders and tolerates a missing fee', () => {
    const [c] = matchOrders([order({
      cancelStatus: { cancelState: 'CANCELED', cancelledDate: '2026-11-21T08:00:00.000Z' },
      totalMarketplaceFee: undefined,
      lineItems: [line({ lineItemId: '1', sku: 'RS-EB-1' })],
    })], lookup);
    expect(c).toMatchObject({ cancelled: true, fees: 0 });

    const [pending] = matchOrders([order({
      cancelStatus: { cancelState: 'IN_PROGRESS' },
      lineItems: [line({ lineItemId: '1', sku: 'RS-EB-1' })],
    })], lookup);
    expect(pending.cancelled).toBe(false);
  });

  it('returns nothing for an order with no known listing', () => {
    expect(matchOrders([order({ lineItems: [line({ lineItemId: '1', sku: 'X', legacyItemId: '1' })] })], lookup))
      .toEqual([]);
  });
});
