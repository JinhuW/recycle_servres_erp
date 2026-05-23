import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { getTestDb } from './helpers/db';

const pdf = join(__dirname, 'fixtures', 'invoice.pdf');

const findSellableLine = (token: string) => freeSellableLine(token);

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

  it('Done consumes stock: decrements the source line qty (status unchanged)', async () => {
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

    const got = await api<{ item: { status: string; qty: number } }>('GET', `/api/inventory/${line.id}`, { token });
    expect(got.body.item.qty).toBe(line.qty - 1);
    expect(got.body.item.status).toBe('Reviewing'); // status is left untouched; qty is the source of truth
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
    const target = await freeSellableLine(mTok);
    const owner = await api<{ item: { user_id: string } }>('GET', `/api/inventory/${target.id}`, { token: mTok });
    const submitterRow = (await api<{ items: { id: string; email: string }[] }>(
      'GET', '/api/members', { token: mTok })).body.items.find(m => m.id === owner.body.item.user_id);
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
    // Walk Draft → Shipped → Awaiting payment → Done via the dedicated route.
    // PATCH no longer accepts a status change (see "PATCH rejects status …").
    for (const to of ['Shipped', 'Awaiting payment', 'Done']) {
      const r = await api('POST', `/api/sell-orders/${id}/status`, {
        token, body: { to, note: 'evidence' },
      });
      expect(r.status).toBe(200);
    }

    const r = await api('PATCH', `/api/sell-orders/${id}`, {
      token,
      body: { lines: [{
        inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn',
        qty: 1, unitPrice: line.sell_price,
      }] },
    });
    expect(r.status).toBe(409);
  });

  it('PATCH rejects status changes — must go through POST /:id/status', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await makeOrder(token);
    // Move to Done via the dedicated route first.
    for (const to of ['Shipped', 'Awaiting payment', 'Done']) {
      const r = await api('POST', `/api/sell-orders/${id}/status`, {
        token, body: { to, note: 'evidence' },
      });
      expect(r.status).toBe(200);
    }
    // PATCH attempting to revert status must 400 AND leave the row untouched.
    const bad = await api<{ error: string }>('PATCH', `/api/sell-orders/${id}`, {
      token, body: { status: 'Draft' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/POST/i);

    const got = await api<{ order: { status: string } }>(
      'GET', `/api/sell-orders/${id}`, { token });
    expect(got.body.order.status).toBe('Done');
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

describe('GET /api/sell-orders — archive filter', () => {
  beforeEach(async () => { await resetDb(); });

  it('hides archived sell orders by default; includes them with ?includeArchived=true', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);

    // Soft-archive directly via SQL (the endpoints don't exist yet).
    const sql = getTestDb();
    await sql`UPDATE sell_orders SET archived_at = NOW() WHERE id = ${id}`;

    const def = await api<{ items: { id: string; archivedAt: string | null }[] }>(
      'GET', '/api/sell-orders', { token },
    );
    expect(def.status).toBe(200);
    expect(def.body.items.find(o => o.id === id)).toBeUndefined();

    const all = await api<{ items: { id: string; archivedAt: string | null }[] }>(
      'GET', '/api/sell-orders?includeArchived=true', { token },
    );
    expect(all.status).toBe(200);
    const row = all.body.items.find(o => o.id === id);
    expect(row).toBeDefined();
    expect(typeof row!.archivedAt).toBe('string');
  });

  it('detail response includes archivedAt', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createDraftSellOrder(token);

    const sql = getTestDb();
    await sql`UPDATE sell_orders SET archived_at = NOW() WHERE id = ${id}`;

    const got = await api<{ order: { id: string; archivedAt: string | null } }>(
      'GET', `/api/sell-orders/${id}`, { token },
    );
    expect(got.status).toBe(200);
    expect(typeof got.body.order.archivedAt).toBe('string');
  });
});

describe('POST /api/sell-orders/:id/archive (+/unarchive)', () => {
  beforeEach(async () => { await resetDb(); });

  // Advance a sell order out of Draft so it is eligible for archive.
  async function nonDraftSellOrder(token: string): Promise<string> {
    const id = await createDraftSellOrder(token);
    const r = await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped', note: 'shipped for test' },
    });
    expect(r.status).toBe(200);
    return id;
  }

  it('manager can archive a non-Draft sell order, and unarchive it back', async () => {
    const { token } = await loginAs(ALEX);
    const id = await nonDraftSellOrder(token);

    const arch = await api('POST', `/api/sell-orders/${id}/archive`, { token });
    expect(arch.status).toBe(200);

    const got = await api<{ order: { archivedAt: string | null } }>(
      'GET', `/api/sell-orders/${id}`, { token },
    );
    expect(typeof got.body.order.archivedAt).toBe('string');

    const unarch = await api('POST', `/api/sell-orders/${id}/unarchive`, { token });
    expect(unarch.status).toBe(200);
    const got2 = await api<{ order: { archivedAt: string | null } }>(
      'GET', `/api/sell-orders/${id}`, { token },
    );
    expect(got2.body.order.archivedAt).toBeNull();
  });
});

