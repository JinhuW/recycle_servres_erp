import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// Creates a customer + an active vendor link via the (Task 5) CRUD endpoint.
async function seedLink(): Promise<{ token: string; customerId: string }> {
  const { token: mgr } = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/customers', {
    token: mgr, body: { name: 'Vendor Co', shortName: 'VendCo' },
  });
  const cust = created.body.id;
  const link = await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr });
  return { token: link.body.token, customerId: cust };
}

describe('vendor public — me & catalog', () => {
  beforeAll(async () => { await resetDb(); });

  it('404s on unknown token (no info leak)', async () => {
    const r = await api('GET', '/api/public/vendor/nope-nope/me');
    expect(r.status).toBe(404);
  });

  it('me returns the customer for a valid token', async () => {
    const { token } = await seedLink();
    const r = await api<{ customer: { name: string } }>('GET', `/api/public/vendor/${token}/me`);
    expect(r.status).toBe(200);
    expect(r.body.customer.name).toBe('Vendor Co');
  });

  it('catalog hides cost/sell_price and non-Done/zero-qty lines', async () => {
    const { token } = await seedLink();
    const r = await api<{ groups: { items: Record<string, unknown>[] }[] }>(
      'GET', `/api/public/vendor/${token}/catalog`);
    expect(r.status).toBe(200);
    const items = r.body.groups.flatMap(g => g.items);
    for (const it of items) {
      expect(it).not.toHaveProperty('unit_cost');
      expect(it).not.toHaveProperty('sell_price');
      expect(it).not.toHaveProperty('profit');
      expect(it.status === undefined || it.status === 'Done').toBe(true);
    }
  });
});
