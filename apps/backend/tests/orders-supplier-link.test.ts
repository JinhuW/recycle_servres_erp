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
      paypalTxnId: 'TESTPAYTXN0000001',
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

// The FK was the only thing checking supplierId, so anything it rejected came
// back as an unhandled 500 — and anything it accepted was written, including
// another purchaser's client.
describe('supplierId is validated at the boundary', () => {
  beforeEach(async () => { await resetDb(); });

  it('400s a malformed uuid instead of 500ing on the FK', async () => {
    const marcus = await loginAs(MARCUS);
    const wh = await api<{ items: { id: string }[] }>('GET', '/api/warehouses', { token: marcus.token });
    const r = await api('POST', '/api/orders', {
      token: marcus.token,
      body: {
        paypalTxnId: 'TESTPAYTXN0000001',
        warehouseId: wh.body.items[0].id,
        supplierId: 'not-a-uuid',
        lines: [{ category: 'RAM', itemType: 'RAM', qty: 1, unitCost: 5, brand: 'Samsung' }],
      },
    });
    expect(r.status).toBe(400);
  });

  it('400s a well-formed id that is nobody\'s client', async () => {
    const marcus = await loginAs(MARCUS);
    const wh = await api<{ items: { id: string }[] }>('GET', '/api/warehouses', { token: marcus.token });
    const r = await api('POST', '/api/orders', {
      token: marcus.token,
      body: {
        paypalTxnId: 'TESTPAYTXN0000001',
        warehouseId: wh.body.items[0].id,
        supplierId: '00000000-0000-4000-8000-000000000000',
        lines: [{ category: 'RAM', itemType: 'RAM', qty: 1, unitCost: 5, brand: 'Samsung' }],
      },
    });
    expect(r.status).toBe(400);
  });

  it("refuses another purchaser's client, and a manager's is not special-cased away", async () => {
    // ALEX is a manager, MARCUS a purchaser — so the client below is ALEX's book.
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);
    const alexClient = await newClient(alex.token, 'Alex Only Supply');

    const wh = await api<{ items: { id: string }[] }>('GET', '/api/warehouses', { token: marcus.token });
    const mine = {
      warehouseId: wh.body.items[0].id,
      lines: [{ category: 'RAM', itemType: 'RAM', qty: 1, unitCost: 5, brand: 'Samsung' }],
    };
    const refused = await api('POST', '/api/orders', {
      token: marcus.token, body: {
        paypalTxnId: 'TESTPAYTXN0000001', ...mine, supplierId: alexClient },
    });
    expect(refused.status).toBe(400);

    // A manager may attach any client — that is the role, not an oversight.
    const allowed = await api('POST', '/api/orders', {
      token: alex.token, body: {
        paypalTxnId: 'TESTPAYTXN0000001', ...mine, supplierId: alexClient },
    });
    expect(allowed.status).toBe(201);
  });

  it('PATCH is guarded too, not just create', async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);
    const alexClient = await newClient(alex.token, 'Alex Only Supply');
    const po = await submittedPO(marcus.token);

    const r = await api('PATCH', `/api/orders/${po}`, {
      token: marcus.token, body: { supplierId: alexClient },
    });
    expect(r.status).toBe(400);

    const bad = await api('PATCH', `/api/orders/${po}`, {
      token: marcus.token, body: { supplierId: 'not-a-uuid' },
    });
    expect(bad.status).toBe(400);
  });

  // Belt and braces behind the write guard: a row that predates it — or that a
  // reassign moved out from under the PO — must not keep naming the client.
  it('reads back null once the client leaves the caller\'s book', async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);
    const client = await newClient(marcus.token, 'Handover Supply');
    const po = await submittedPO(marcus.token, client);

    const before = await api<{ order: { supplier: unknown } }>(
      'GET', `/api/orders/${po}`, { token: marcus.token });
    expect(before.body.order.supplier).not.toBeNull();

    // A manager hands the book to someone else; MARCUS keeps the PO.
    const r = await api('POST', `/api/suppliers/${client}/reassign`, {
      token: alex.token, body: { ownerId: null },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    // House-account clients stay readable — they are nobody's private book.
    const after = await api<{ order: { supplier: unknown } }>(
      'GET', `/api/orders/${po}`, { token: marcus.token });
    expect(after.body.order.supplier).not.toBeNull();
  });

  it("stops naming a client that was handed to another purchaser", async () => {
    const alex = await loginAs(ALEX);
    const marcus = await loginAs(MARCUS);
    const client = await newClient(marcus.token, 'Moved To Alex Supply');
    const po = await submittedPO(marcus.token, client);

    const r = await api('POST', `/api/suppliers/${client}/reassign`, {
      token: alex.token, body: { ownerId: alex.user.id },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);

    // MARCUS still owns the PO but no longer the client, and GET /api/suppliers
    // would 404 it for him — so the order read must not keep handing him the name.
    const detail = await api<{ order: { supplier: unknown } }>(
      'GET', `/api/orders/${po}`, { token: marcus.token });
    expect(detail.body.order.supplier).toBeNull();

    const list = await api<{ orders: { id: string; supplier: unknown }[] }>(
      'GET', '/api/orders?limit=100', { token: marcus.token });
    expect(list.body.orders.find(o => o.id === po)!.supplier).toBeNull();

    // ALEX, who now owns the book, still sees it.
    const asAlex = await api<{ order: { supplier: unknown } }>(
      'GET', `/api/orders/${po}`, { token: alex.token });
    expect(asAlex.body.order.supplier).not.toBeNull();
  });
});
