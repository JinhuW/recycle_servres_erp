import { beforeEach, describe, it, expect } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

// Any open stage may jump straight to Done (mark paid at any point); Closed
// is the only status that cannot reach Done.

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

async function newDraft(token: string): Promise<string> {
  const line = await freeSellableLine(token, 1);
  const customerId = await firstCustomerId(token);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn', qty: 1, unitPrice: line.sell_price }] },
  });
  return r.body.id;
}

describe('sell-order status — direct-to-Done transitions', () => {
  beforeEach(async () => { await resetDb(); });

  it('Draft → Done directly succeeds', async () => {
    const { token } = await loginAs(ALEX);
    const id = await newDraft(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Done', note: 'paid' } });
    expect(r.status).toBe(200);
    const got = await api<{ order: { status: string } }>('GET', `/api/sell-orders/${id}`, { token });
    expect(got.body.order.status).toBe('Done');
  });

  it('Shipped → Done directly succeeds', async () => {
    const { token } = await loginAs(ALEX);
    const id = await newDraft(token);
    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 'ship' } });
    const r = await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Done', note: 'paid' } });
    expect(r.status).toBe(200);
  });

  it('Closed → Done is rejected (409 illegal transition)', async () => {
    const { token } = await loginAs(ALEX);
    const id = await newDraft(token);
    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Closed', note: 'drop', closeReasonId: 'other' } });
    const r = await api<{ error: string }>('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Done', note: 'paid' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/illegal transition/);
  });
});
