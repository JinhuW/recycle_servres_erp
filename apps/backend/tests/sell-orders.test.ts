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
