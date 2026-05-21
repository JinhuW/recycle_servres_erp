import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

// C2 regression: the status read + idempotency guard ran OUTSIDE the
// transaction, so two concurrent POST /:id/status {to:'Done'} (double
// submit / network retry) both passed the guard, both entered sql.begin,
// and stock was consumed twice. The guard must be re-evaluated inside the
// transaction under a row lock so the second request is a true no-op.

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

describe('POST /api/sell-orders/:id/status — Done is idempotent under concurrency', () => {
  beforeEach(async () => { await resetDb(); });

  it('consumes source stock exactly once when Done is submitted twice concurrently', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 3); // need qty headroom to detect a double decrement
    const customerId = await firstCustomerId(token);

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: line.sell_price }],
      },
    });
    const soId = create.body.id;
    await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Shipped', note: 's' } });
    await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Awaiting payment', note: 'a' } });

    // Fire two Done transitions concurrently.
    const [a, b] = await Promise.all([
      api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Done', note: 'paid' } }),
      api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Done', note: 'paid' } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const got = await api<{ item: { qty: number } }>('GET', `/api/inventory/${line.id}`, { token });
    // Sold qty was 1, so the source line must drop by exactly 1 — never 2.
    expect(got.body.item.qty).toBe(line.qty - 1);
  });
});
