// Attributing a purchase order to a client. The load-bearing rule: naming who
// we bought from is bookkeeping, like a note — it must never bounce a submitted
// PO back to Draft for a manager to re-review.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

async function newClient(token: string, name: string) {
  const r = await api<{ id: string }>('POST', '/api/suppliers', { token, body: { name } });
  return r.body.id;
}
async function submittedPO(token: string, supplierId?: string) {
  const wh = await api<{ items: { id: string }[] }>('GET', '/api/warehouses', { token });
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      warehouseId: wh.body.items[0].id,
      supplierId,
      lines: [{ category: 'RAM', itemType: 'RAM', qty: 4, unitCost: 25, brand: 'Samsung' }],
    },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await api('POST', `/api/orders/${created.body.id}/advance`, { token, body: {} });
  return created.body.id;
}

describe('purchase orders carry a client', () => {
  beforeEach(async () => { await resetDb(); });

  it('records it at creation and returns it on read', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await newClient(marcus.token, 'Denver Datacenter Liquidators');
    const po = await submittedPO(marcus.token, id);
    const d = await api<{ order: { supplier: { id: string; name: string } | null } }>(
      'GET', `/api/orders/${po}`, { token: marcus.token });
    expect(d.body.order.supplier).toEqual({ id, name: 'Denver Datacenter Liquidators' });
  });

  it('lets a purchaser attribute a SUBMITTED order without reverting it to Draft', async () => {
    const marcus = await loginAs(MARCUS);
    const po = await submittedPO(marcus.token);
    const before = await api<{ order: { lifecycle: string } }>(
      'GET', `/api/orders/${po}`, { token: marcus.token });
    expect(before.body.order.lifecycle).not.toBe('draft');

    const id = await newClient(marcus.token, 'Front Range Recyclers');
    const patch = await api('PATCH', `/api/orders/${po}`, {
      token: marcus.token, body: { supplierId: id } });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);

    const after = await api<{ order: { lifecycle: string; supplier: { name: string } | null } }>(
      'GET', `/api/orders/${po}`, { token: marcus.token });
    expect(after.body.order.supplier!.name).toBe('Front Range Recyclers');
    // the whole point: bookkeeping must not cost a manager re-review
    expect(after.body.order.lifecycle).toBe(before.body.order.lifecycle);
  });

  it('records the change in the order audit trail', async () => {
    const marcus = await loginAs(MARCUS);
    const po = await submittedPO(marcus.token);
    const id = await newClient(marcus.token, 'Audited Co');
    await api('PATCH', `/api/orders/${po}`, { token: marcus.token, body: { supplierId: id } });
    const ev = await api<{ events: { kind: string; changes?: unknown }[] }>(
      'GET', `/api/orders/${po}/events`, { token: (await loginAs(ALEX)).token });
    const meta = ev.body.events.filter((e) => e.kind === 'meta_changed');
    expect(JSON.stringify(meta)).toMatch(/supplier_id/);
  });

  it('clears a wrong attribution with null (a COALESCE update could not)', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await newClient(marcus.token, 'Wrong Co');
    const po = await submittedPO(marcus.token, id);
    await api('PATCH', `/api/orders/${po}`, { token: marcus.token, body: { supplierId: null } });
    const d = await api<{ order: { supplier: unknown } }>(
      'GET', `/api/orders/${po}`, { token: marcus.token });
    expect(d.body.order.supplier).toBeNull();
  });

  it('feeds the client rollups from real order lines', async () => {
    const marcus = await loginAs(MARCUS);
    const id = await newClient(marcus.token, 'Rollup Co');
    await submittedPO(marcus.token, id);
    const d = await api<{ poCount: number; itemTypes: string[]; sold: { item_type: string; qty: number }[] }>(
      'GET', `/api/suppliers/${id}`, { token: marcus.token });
    expect(d.body.poCount).toBe(1);
    expect(d.body.itemTypes).toContain('RAM');
    expect(d.body.sold[0].qty).toBe(4);
  });

  it('attributes a delivered package automatically when its seller is already a client', async () => {
    const marcus = await loginAs(MARCUS);
    const sql = getTestDb();
    const id = await newClient(marcus.token, 'Package Seller Co');
    const pkg = await api<{ package: { id: string } }>('POST', '/api/packages', {
      token: marcus.token,
      body: { trackingNumber: '1Z999AA10123456784', carrier: 'UPS',
              sellerName: 'package seller co!', source: 'local' },
    });
    expect(pkg.status).toBe(201);
    await sql`UPDATE packages SET status = 'delivered' WHERE id = ${pkg.body.package.id}`;
    const po = await api<{ orderId: string }>('POST', `/api/packages/${pkg.body.package.id}/create-po`,
      { token: marcus.token, body: {} });
    expect(po.status).toBe(201);
    const d = await api<{ order: { supplier: { id: string } | null } }>(
      'GET', `/api/orders/${po.body.orderId}`, { token: marcus.token });
    expect(d.body.order.supplier?.id).toBe(id);
  });
});
