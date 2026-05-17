import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const pdf = join(__dirname, 'fixtures', 'invoice.pdf');

async function findSellableLine(token: string): Promise<{ id: string; qty: number; unit_cost: number; sell_price: number }> {
  const r = await api<{ items: Array<{ id: string; status: string; qty: number; unit_cost: number; sell_price: number | null }> }>(
    'GET', '/api/inventory?status=Reviewing', { token });
  const line = r.body.items.find(i => i.sell_price != null);
  if (!line) throw new Error('no sellable line in seed');
  return { id: line.id, qty: line.qty, unit_cost: line.unit_cost, sell_price: line.sell_price as number };
}

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  if (r.status !== 200 || !r.body.items?.length) throw new Error('no customers in seed');
  return r.body.items[0].id;
}

async function createDraftSellOrder(token: string): Promise<string> {
  const line = await findSellableLine(token);
  const customerId = await firstCustomerId(token);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId,
      lines: [{
        inventoryId: line.id, category: 'RAM', label: 'Sample',
        partNumber: 'PN-1', qty: 1, unitPrice: line.sell_price,
        warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
      }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe('POST /api/sell-orders/:id/status', () => {
  beforeEach(async () => { await resetDb(); });

  it('Shipped requires note OR attachments', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    const bad = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped' },
    });
    expect(bad.status).toBe(400);
  });

  it('Shipped accepts a note', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped', note: 'FedEx 7732' },
    });
    expect(r.status).toBe(200);
    const got = await api<{ order: { status: string; statusMeta?: Record<string, { note?: string }> } }>(
      'GET', `/api/sell-orders/${id}`, { token });
    expect(got.body.order.status).toBe('Shipped');
    expect(got.body.order.statusMeta?.Shipped?.note).toBe('FedEx 7732');
  });

  it('Awaiting payment accepts attachments', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);
    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Shipped', note: 'ship' } });

    const file = new Blob([readFileSync(pdf)], { type: 'application/pdf' });
    const up = await multipart('/api/attachments', { file }, { token });
    const attachId = (up.body as { id: string }).id;

    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Awaiting payment', attachmentIds: [attachId] },
    });
    expect(r.status).toBe(200);
  });

  it('Done flips underlying inventory lines to Done', async () => {
    const { token } = await loginAs(ALEX);
    const line = await findSellableLine(token);
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
    await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Done', note: 'paid' } });

    const got = await api<{ item: { status: string } }>('GET', `/api/inventory/${line.id}`, { token });
    expect(got.body.item.status).toBe('Done');
  });

  it('purchaser is forbidden', async () => {
    const { token: mTok } = await loginAs(ALEX);
    const id = await createDraftSellOrder(mTok);
    const { token: pTok } = await loginAs(MARCUS);
    const r = await api('POST', `/api/sell-orders/${id}/status`, { token: pTok, body: { to: 'Shipped', note: 's' } });
    expect(r.status).toBe(403);
  });
});

describe('payment_received notification', () => {
  beforeEach(async () => { await resetDb(); });

  it('notifies submitter when sell order is Done', async () => {
    const { token: mTok } = await loginAs(ALEX);
    const list = await api<{ items: { id: string; user_id: string; sell_price: number | null }[] }>(
      'GET', '/api/inventory?status=Reviewing', { token: mTok });
    const target = list.body.items.find(i => i.sell_price != null)!;
    const submitterRow = (await api<{ items: { id: string; email: string }[] }>(
      'GET', '/api/members', { token: mTok })).body.items.find(m => m.id === target.user_id);
    const submitterEmail = submitterRow!.email;
    const { token: subTok } = await loginAs(submitterEmail);

    // Use firstCustomerId helper from earlier in the file
    const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token: mTok });
    const customerId = customers.body.items[0].id;

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: mTok,
      body: { customerId, lines: [{
        inventoryId: target.id, category: 'RAM', label: 'x', partNumber: 'pn',
        qty: 1, unitPrice: target.sell_price as number,
      }] },
    });
    const soId = create.body.id;
    await api('POST', `/api/sell-orders/${soId}/status`, { token: mTok, body: { to: 'Shipped', note: 's' } });
    await api('POST', `/api/sell-orders/${soId}/status`, { token: mTok, body: { to: 'Awaiting payment', note: 'a' } });
    await api('POST', `/api/sell-orders/${soId}/status`, { token: mTok, body: { to: 'Done', note: 'paid' } });

    const got = await api<{ items: { kind: string }[] }>('GET', '/api/notifications', { token: subTok });
    expect(got.body.items.some(i => i.kind === 'payment_received')).toBe(true);
  });
});

describe('PATCH /api/sell-orders/:id — editing customer + lines', () => {
  beforeEach(async () => { await resetDb(); });

  async function makeOrder(token: string) {
    const line = await findSellableLine(token);
    const customerId = await firstCustomerId(token);
    const r = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'Sample', partNumber: 'PN-1',
          qty: 1, unitPrice: line.sell_price, warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
        }],
      },
    });
    expect(r.status).toBe(201);
    return { id: r.body.id, line };
  }

  it('replaces lines and updates notes in one PATCH', async () => {
    const { token } = await loginAs(ALEX);
    const { id, line } = await makeOrder(token);
    const newPrice = +(line.sell_price + 5).toFixed(2);

    const r = await api('PATCH', `/api/sell-orders/${id}`, {
      token,
      body: {
        notes: 'edited note',
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'Edited label', partNumber: 'PN-2',
          qty: 1, unitPrice: newPrice, warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
        }],
      },
    });
    expect(r.status).toBe(200);

    const got = await api<{ order: {
      notes: string;
      lines: { label: string; unitPrice: number }[];
    } }>('GET', `/api/sell-orders/${id}`, { token });
    expect(got.body.order.notes).toBe('edited note');
    expect(got.body.order.lines).toHaveLength(1);
    expect(got.body.order.lines[0].label).toBe('Edited label');
    expect(got.body.order.lines[0].unitPrice).toBe(newPrice);
  });

  it('updates the customer', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await makeOrder(token);
    const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
    const target = customers.body.items[customers.body.items.length - 1].id;

    const r = await api('PATCH', `/api/sell-orders/${id}`, { token, body: { customerId: target } });
    expect(r.status).toBe(200);

    const got = await api<{ order: { customer: { id: string } } }>(
      'GET', `/api/sell-orders/${id}`, { token });
    expect(got.body.order.customer.id).toBe(target);
  });

  it('rejects qty exceeding inventory on edit', async () => {
    const { token } = await loginAs(ALEX);
    const { id, line } = await makeOrder(token);
    const r = await api('PATCH', `/api/sell-orders/${id}`, {
      token,
      body: { lines: [{
        inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
        qty: line.qty + 99, unitPrice: line.sell_price,
      }] },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/qty/i);
  });

  it('rejects line/customer edits on a Done order', async () => {
    const { token } = await loginAs(ALEX);
    const { id, line } = await makeOrder(token);
    await api('PATCH', `/api/sell-orders/${id}`, { token, body: { status: 'Done' } });

    const r = await api('PATCH', `/api/sell-orders/${id}`, {
      token,
      body: { lines: [{
        inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
        qty: 1, unitPrice: line.sell_price,
      }] },
    });
    expect(r.status).toBe(409);
  });
});

describe('sell-order qty clamp', () => {
  beforeEach(async () => { await resetDb(); });

  it('POST rejects qty > inventory line qty', async () => {
    const { token } = await loginAs(ALEX);
    const line = await findSellableLine(token);
    const customerId = await firstCustomerId(token);
    const r = await api('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{
        inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
        qty: line.qty + 99, unitPrice: line.sell_price,
      }]},
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/qty/i);
  });
});

describe('sell-order discount clamp', () => {
  beforeEach(async () => { await resetDb(); });

  it('clamps an out-of-range discountPct so the total never goes negative', async () => {
    const { token } = await loginAs(ALEX);
    const line = await findSellableLine(token);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        discountPct: 5, // bad input: discountPct is a 0..1 fraction
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
          qty: 1, unitPrice: 100, warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
        }],
      },
    });
    expect(create.status).toBe(201);

    const detail = await api<{ order: { discountPct: number; total: number } }>(
      'GET', `/api/sell-orders/${create.body.id}`, { token });
    expect(detail.status).toBe(200);
    expect(detail.body.order.discountPct).toBeLessThanOrEqual(1);
    expect(detail.body.order.discountPct).toBeGreaterThanOrEqual(0);
    expect(detail.body.order.total).toBeGreaterThanOrEqual(0);
  });
});
