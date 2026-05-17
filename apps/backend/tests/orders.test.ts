import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('POST /api/orders defaults', () => {
  beforeEach(async () => { await resetDb(); });

  it('creates an order in lifecycle="draft" with line status="Draft"', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        warehouseId: 'WH-LA1',
        payment: 'company',
        lines: [{
          category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          classification: 'RDIMM', speed: '3200',
          partNumber: 'M393A4K40DB3-CWE', condition: 'Pulled — Tested',
          qty: 4, unitCost: 78.5,
        }],
      },
    });
    expect(r.status).toBe(201);
    const id = r.body.id;
    expect(id).toMatch(/^SO-\d+$/);

    const got = await api<{ order: { lifecycle: string; lines: { status: string }[] } }>(
      'GET', '/api/orders/' + id, { token },
    );
    expect(got.status).toBe(200);
    expect(got.body.order.lifecycle).toBe('draft');
    expect(got.body.order.lines[0].status).toBe('Draft');
  });

  it('rejects mixed-category lines with 400', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        lines: [
          { category: 'RAM', qty: 1, unitCost: 10, condition: 'New' },
          { category: 'SSD', qty: 1, unitCost: 10, condition: 'New' },
        ],
      },
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/orders/:id/advance', () => {
  beforeEach(async () => { await resetDb(); });

  it('purchaser can advance own Draft → in_transit', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    const id = created.body.id;
    const r = await api('POST', `/api/orders/${id}/advance`, { token: pTok });
    expect(r.status).toBe(200);
    const got = await api<{ order: { lifecycle: string; lines: { status: string }[] } }>(
      'GET', `/api/orders/${id}`, { token: pTok });
    expect(got.body.order.lifecycle).toBe('in_transit');
    expect(got.body.order.lines[0].status).toBe('In Transit');
  });

  it('purchaser cannot jump past in_transit', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok });
    const r = await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok });
    expect(r.status).toBe(403);
  });

  it('manager can advance to any stage', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const { token: mTok } = await loginAs(ALEX);
    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok });
    const r = await api('POST', `/api/orders/${c.body.id}/advance`, {
      token: mTok, body: { toStage: 'reviewing' } });
    expect(r.status).toBe(200);
    const got = await api<{ order: { lifecycle: string } }>('GET', `/api/orders/${c.body.id}`, { token: mTok });
    expect(got.body.order.lifecycle).toBe('reviewing');
  });
});

describe('notifications on order advance', () => {
  beforeEach(async () => { await resetDb(); });

  it('advancing to in_transit notifies managers', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const { token: mTok } = await loginAs(ALEX);
    const before = await api<{ unreadCount: number }>('GET', '/api/notifications', { token: mTok });

    const c = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    await api('POST', `/api/orders/${c.body.id}/advance`, { token: pTok });

    const after = await api<{ unreadCount: number; items: { kind: string; title: string }[] }>(
      'GET', '/api/notifications', { token: mTok });
    expect(after.body.unreadCount).toBeGreaterThan(before.body.unreadCount);
    expect(after.body.items.some(i => i.kind === 'order_submitted')).toBe(true);
  });
});

describe('GET /api/orders — per-order commission rate', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns the order\'s own commission_rate (null when unset)', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ orders: { id: string; commissionRate: number | null }[] }>(
      'GET', '/api/orders', { token });
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBeGreaterThan(0);
    // seed: drafts are null, others 0.075
    expect(r.body.orders.some(o => o.commissionRate === 0.075)).toBe(true);
  });

  it('manager can PATCH commissionRate; purchaser is forbidden', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const list = await api<{ orders: { id: string; userId: string }[] }>(
      'GET', '/api/orders', { token: mgr });
    const target = list.body.orders[0];

    const ok = await api('PATCH', `/api/orders/${target.id}`,
      { token: mgr, body: { commissionRate: 0.1 } });
    expect(ok.status).toBe(200);

    const after = await api<{ orders: { id: string; commissionRate: number | null }[] }>(
      'GET', '/api/orders', { token: mgr });
    expect(after.body.orders.find(o => o.id === target.id)!.commissionRate).toBeCloseTo(0.1, 4);

    // A purchaser editing their own order's rate is rejected.
    const { token: pur, user: pu } = await loginAs(MARCUS);
    const mine = (await api<{ orders: { id: string; userId: string }[] }>(
      'GET', '/api/orders', { token: pur })).body.orders.find(o => o.userId === pu.id)!;
    const denied = await api('PATCH', `/api/orders/${mine.id}`,
      { token: pur, body: { commissionRate: 0.2 } });
    expect(denied.status).toBe(403);
  });

  it('clamps out-of-range rate and allows null to unset', async () => {
    const { token: mgr } = await loginAs(ALEX);
    const id = (await api<{ orders: { id: string }[] }>('GET', '/api/orders', { token: mgr })).body.orders[0].id;
    await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { commissionRate: 5 } });
    let r = await api<{ orders: { id: string; commissionRate: number | null }[] }>('GET', '/api/orders', { token: mgr });
    expect(r.body.orders.find(o => o.id === id)!.commissionRate).toBe(1);
    await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { commissionRate: null } });
    r = await api<{ orders: { id: string; commissionRate: number | null }[] }>('GET', '/api/orders', { token: mgr });
    expect(r.body.orders.find(o => o.id === id)!.commissionRate).toBeNull();
  });
});

describe('concurrent order creation gets unique ids', () => {
  beforeEach(async () => { await resetDb(); });

  it('20 simultaneous draft creates all succeed with distinct ids', async () => {
    const { token } = await loginAs(MARCUS);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        api<{ id: string }>('POST', '/api/orders/draft', { token, body: { category: 'RAM' } })),
    );
    for (const r of results) expect(r.status).toBe(201);
    const ids = results.map(r => r.body.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('orders.commission_rate column', () => {
  beforeEach(async () => { await resetDb(); });

  it('exists and is nullable, seeded non-null on at least one order', async () => {
    const db = getTestDb();
    const rows = await db<{ commission_rate: number | null }[]>`
      SELECT commission_rate FROM orders
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.commission_rate !== null)).toBe(true);
    expect(rows.some(r => r.commission_rate === null)).toBe(true);
  });
});
