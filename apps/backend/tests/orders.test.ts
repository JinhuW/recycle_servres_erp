import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
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

describe('GET /api/orders — commission rate', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns each order owner\'s DB commission rate (default 0.075)', async () => {
    const { token } = await loginAs(MARCUS);
    await api('POST', '/api/orders', {
      token,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 2, unitCost: 10, condition: 'New' }] },
    });
    const r = await api<{ orders: { commissionRate: number }[] }>(
      'GET', '/api/orders', { token });
    expect(r.status).toBe(200);
    expect(r.body.orders.length).toBeGreaterThan(0);
    for (const o of r.body.orders) expect(o.commissionRate).toBe(0.075);
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
