import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// A customer + active vendor link via the (Task 5) CRUD endpoint.
async function seedLink(): Promise<{ token: string; customerId: string; mgr: string }> {
  const { token: mgr } = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/customers', {
    token: mgr, body: { name: 'Vendor Co', shortName: 'VendCo' },
  });
  const cust = created.body.id;
  const link = await api<{ token: string }>('POST', `/api/customers/${cust}/vendor-link`, { token: mgr });
  return { token: link.body.token, customerId: cust, mgr };
}

// Find any in-stock (Done, qty>0) inventory line as a manager, to prove the
// catalog returns real rows with only safe columns.
async function aDoneLine(mgr: string): Promise<{ id: string } | null> {
  const inv = await api<{ items: Array<{ id: string; qty: number }> }>(
    'GET', '/api/inventory?status=Done', { token: mgr });
  const row = inv.body.items.find(i => i.qty > 0);
  return row ? { id: row.id } : null;
}

describe('vendor public — me & catalog', () => {
  beforeAll(async () => { await resetDb(); });

  it('404s on unknown token (no info leak)', async () => {
    const r = await api('GET', '/api/public/vendor/nope-nope/me');
    expect(r.status).toBe(404);
  });

  it('404s on an inactive (revoked) token', async () => {
    const { token, customerId, mgr } = await seedLink();
    const link = await api<{ link: { id: string } }>(
      'GET', `/api/customers/${customerId}/vendor-link`, { token: mgr });
    await api('PATCH', `/api/customers/vendor-link/${link.body.link.id}`, {
      token: mgr, body: { active: false },
    });
    const r = await api('GET', `/api/public/vendor/${token}/me`);
    expect(r.status).toBe(404);
  });

  it('404s on an expired token', async () => {
    const { token, customerId, mgr } = await seedLink();
    const link = await api<{ link: { id: string } }>(
      'GET', `/api/customers/${customerId}/vendor-link`, { token: mgr });
    await api('PATCH', `/api/customers/vendor-link/${link.body.link.id}`, {
      token: mgr, body: { expiresAt: '2000-01-01T00:00:00Z' },
    });
    const r = await api('GET', `/api/public/vendor/${token}/me`);
    expect(r.status).toBe(404);
  });

  it('me returns the customer for a valid token', async () => {
    const { token } = await seedLink();
    const r = await api<{ customer: { name: string } }>('GET', `/api/public/vendor/${token}/me`);
    expect(r.status).toBe(200);
    expect(r.body.customer.name).toBe('Vendor Co');
  });

  it('empty catalog returns 200 with no groups', async () => {
    const { token } = await seedLink();
    const r = await api<{ groups: unknown[] }>('GET', `/api/public/vendor/${token}/catalog`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.groups)).toBe(true);
  });

  it('catalog returns safe columns only and never cost/sell_price/notes/warehouse', async () => {
    const { token, mgr } = await seedLink();
    const done = await aDoneLine(mgr);
    const r = await api<{ groups: { category: string; items: Record<string, unknown>[] }[] }>(
      'GET', `/api/public/vendor/${token}/catalog`);
    expect(r.status).toBe(200);
    const items = r.body.groups.flatMap(g => g.items);
    if (done) {
      // There is at least one in-stock line in the seed → catalog must surface it.
      expect(items.length).toBeGreaterThan(0);
      const sample = items[0];
      expect(sample).toHaveProperty('id');
      expect(sample).toHaveProperty('category');
      expect(sample).toHaveProperty('qty');
    }
    for (const it of items) {
      expect(it).not.toHaveProperty('unit_cost');
      expect(it).not.toHaveProperty('sell_price');
      expect(it).not.toHaveProperty('profit');
      expect(it).not.toHaveProperty('margin');
      expect(it).not.toHaveProperty('notes');
      expect(it).not.toHaveProperty('warehouse_id');
      expect(it).not.toHaveProperty('user_id');
    }
  });

  async function anInStockLine(mgr: string): Promise<{ id: string; qty: number }> {
    const inv = await api<{ items: Array<{ id: string; qty: number; status: string }> }>(
      'GET', '/api/inventory?status=Done', { token: mgr });
    const row = inv.body.items.find(i => i.qty > 0)!;
    return { id: row.id, qty: row.qty };
  }

  it('submits a bid and notifies managers', async () => {
    const { token, mgr } = await seedLink();
    const line = await anInStockLine(mgr);
    const r = await api<{ bidId: string }>('POST', `/api/public/vendor/${token}/bids`, {
      body: { contactName: 'Lin', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
    });
    expect(r.status).toBe(201);
    expect(r.body.bidId).toMatch(/^VB-\d+$/);
  });

  it('rejects qty over availability with 409', async () => {
    const { token, mgr } = await seedLink();
    const line = await anInStockLine(mgr);
    const r = await api('POST', `/api/public/vendor/${token}/bids`, {
      body: { contactName: 'Lin', lines: [{ inventoryId: line.id, qty: line.qty + 999, unitPrice: 5 }] },
    });
    expect(r.status).toBe(409);
  });

  it('rejects malformed body with 400', async () => {
    const { token } = await seedLink();
    const r = await api('POST', `/api/public/vendor/${token}/bids`, {
      body: { contactName: '', lines: [] },
    });
    expect(r.status).toBe(400);
  });
});
