import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

// The sell-order discount concept is being removed entirely (per product
// decision). Every sell-order detail must report total === subtotal, the
// discount field must be gone from the response, and POST/PATCH must ignore
// any discountPct in the body.

describe('Sell orders: no discount, total === subtotal', () => {
  beforeEach(async () => { await resetDb(); });

  it('the seeded SO-4006 reports total === subtotal', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{
      order: { subtotal: number; total: number; discount?: number; discountPct?: number };
    }>('GET', '/api/sell-orders/SO-4006', { token });
    expect(r.status).toBe(200);
    expect(r.body.order.total).toBeCloseTo(r.body.order.subtotal, 2);
    expect(r.body.order.discount ?? 0).toBe(0);
    expect(r.body.order.discountPct ?? 0).toBe(0);
  });

  it('POST ignores any discountPct in the body — created order has total === subtotal', async () => {
    const { token } = await loginAs(ALEX);
    const customerId = (await getTestDb()<{ id: string }[]>`SELECT id FROM customers LIMIT 1`)[0].id;
    // The seed legitimately attaches its first sellable lines to seeded sell
    // orders, so naively picking "first Reviewing line with sell_price" can
    // land on a line already committed to an open order — the
    // one-open-order-per-line invariant then rejects this POST with 400 and
    // the test flakes. `freeSellableLine` walks the candidates and returns one
    // that is genuinely free.
    const line = await freeSellableLine(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        // A client trying to set a discount must not be honored after removal.
        discountPct: 0.20,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: line.sell_price }],
      },
    });
    expect(create.status).toBe(201);

    const r = await api<{ order: { subtotal: number; total: number; discountPct?: number } }>(
      'GET', `/api/sell-orders/${create.body.id}`, { token });
    expect(r.body.order.total).toBeCloseTo(r.body.order.subtotal, 2);
    expect(r.body.order.discountPct ?? 0).toBe(0);
  });
});
