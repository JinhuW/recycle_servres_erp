import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

// A line whose PO reached the final lifecycle stage (status='Done') is fully
// received and still in stock — it must be sellable, matching the frontend's
// isSellable (Reviewing OR Done). Regression for the backend-only mismatch
// that rejected Done lines with "inventory line not sellable (status=Done)".
describe('sell order accepts a Done (fully-received) inventory line', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates a sell order from a line whose PO is Done', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);

    const inv = await api<{ item: { order_id: string } }>(
      'GET', `/api/inventory/${line.id}`, { token });
    const orderId = inv.body.item.order_id;

    const adv = await api('POST', `/api/orders/${orderId}/advance`, {
      token, body: { toStage: 'done' },
    });
    expect(adv.status).toBe(200);

    const after = await api<{ item: { status: string } }>(
      'GET', `/api/inventory/${line.id}`, { token });
    expect(after.body.item.status).toBe('Done');

    const customers = await api<{ items: { id: string }[] }>(
      'GET', '/api/customers', { token });
    const customerId = customers.body.items[0].id;

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM',
        label: 'x', partNumber: 'pn', qty: 1, unitPrice: line.sell_price }] },
    });
    expect(create.status).toBe(201);
  });
});
