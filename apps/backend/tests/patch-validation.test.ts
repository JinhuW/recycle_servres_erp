import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

describe('PATCH mass-assignment / type validation', () => {
  beforeEach(async () => { await resetDb(); });

  it('customers: rejects wrong-typed fields, accepts correct ones', async () => {
    const { token } = await loginAs(ALEX);
    const id = await firstCustomerId(token);

    expect((await api('PATCH', `/api/customers/${id}`, { token, body: { active: 'yes' } })).status).toBe(400);
    expect((await api('PATCH', `/api/customers/${id}`, { token, body: { tags: 'nope' } })).status).toBe(400);
    expect((await api('PATCH', `/api/customers/${id}`, { token, body: { name: 123 } })).status).toBe(400);

    const ok = await api('PATCH', `/api/customers/${id}`, { token, body: { contactPhone: '+1-555-0000', active: false } });
    expect(ok.status).toBe(200);
  });

  it('categories: rejects wrong-typed fields, accepts correct ones', async () => {
    const { token } = await loginAs(ALEX);

    expect((await api('PATCH', '/api/categories/RAM', { token, body: { defaultMargin: 'high' } })).status).toBe(400);
    expect((await api('PATCH', '/api/categories/RAM', { token, body: { enabled: 'true' } })).status).toBe(400);
    expect((await api('PATCH', '/api/categories/RAM', { token, body: { position: 1.5 } })).status).toBe(400);

    expect((await api('PATCH', '/api/categories/RAM', { token, body: { enabled: true, defaultMargin: 25 } })).status).toBe(200);
  });

  it('workspace: rejects bad values for known typed keys, allows arbitrary string keys', async () => {
    const { token } = await loginAs(ALEX);

    expect((await api('PATCH', '/api/workspace', { token, body: { target_margin: 'lots' } })).status).toBe(400);
    expect((await api('PATCH', '/api/workspace', { token, body: { low_margin_floor: 5 } })).status).toBe(400); // out of [0,1)
    expect((await api('PATCH', '/api/workspace', { token, body: { upload_max_bytes: -1 } })).status).toBe(400);
    expect((await api('PATCH', '/api/workspace', { token, body: { upload_allowed_mime: 'image/png' } })).status).toBe(400);

    // Stored-XSS gate: SVG / HTML aren't on the safe allowlist (they execute
    // scripts when served from a public bucket). image/png is.
    expect((await api('PATCH', '/api/workspace',
      { token, body: { upload_allowed_mime: ['image/svg+xml'] } })).status).toBe(400);
    expect((await api('PATCH', '/api/workspace',
      { token, body: { upload_allowed_mime: ['text/html'] } })).status).toBe(400);
    expect((await api('PATCH', '/api/workspace',
      { token, body: { upload_allowed_mime: ['image/png', 'image/svg+xml'] } })).status).toBe(400);
    expect((await api('PATCH', '/api/workspace',
      { token, body: { upload_allowed_mime: ['image/png', 'image/jpeg'] } })).status).toBe(200);

    // Unknown/free-form keys still pass (e.g. currency) — don't break the settings UI.
    expect((await api('PATCH', '/api/workspace', { token, body: { currency: 'HKD' } })).status).toBe(200);
    expect((await api('PATCH', '/api/workspace', { token, body: { target_margin: 0.4 } })).status).toBe(200);
  });
});

describe('qty / price range gates — must 400, never 500', () => {
  beforeEach(async () => { await resetDb(); });

  it('inventory PATCH rejects qty=0 / negative price up front', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);

    const zeroQty = await api('PATCH', `/api/inventory/${line.id}`, { token, body: { qty: 0 } });
    expect(zeroQty.status).toBe(400);

    const negQty = await api('PATCH', `/api/inventory/${line.id}`, { token, body: { qty: -3 } });
    expect(negQty.status).toBe(400);

    const negCost = await api('PATCH', `/api/inventory/${line.id}`, { token, body: { unitCost: -1 } });
    expect(negCost.status).toBe(400);

    const negSell = await api('PATCH', `/api/inventory/${line.id}`, { token, body: { sellPrice: -0.5 } });
    expect(negSell.status).toBe(400);
  });

  it('orders PATCH rejects qty=0 / negative cost on line edits and adds', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pTok,
      body: { category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', qty: 1, unitCost: 10, condition: 'New' }] },
    });
    const id = created.body.id;
    const detail = await api<{ order: { lines: { id: string }[] } }>(
      'GET', `/api/orders/${id}`, { token: pTok });
    const lineId = detail.body.order.lines[0].id;

    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pTok, body: { lines: [{ id: lineId, qty: 0 }] },
    })).status).toBe(400);
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pTok, body: { lines: [{ id: lineId, unitCost: -1 }] },
    })).status).toBe(400);
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: pTok,
      body: { addLines: [{ category: 'RAM', qty: 0, unitCost: 5, condition: 'New' }] },
    })).status).toBe(400);
  });

  it('sell-orders POST rejects qty=0 / negative unitPrice', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
    const customerId = customers.body.items[0].id;

    const zero = await api('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{
        inventoryId: line.id, category: 'RAM', label: 'x',
        partNumber: 'pn', qty: 0, unitPrice: line.sell_price,
      }] },
    });
    expect(zero.status).toBe(400);

    const neg = await api('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{
        inventoryId: line.id, category: 'RAM', label: 'x',
        partNumber: 'pn', qty: 1, unitPrice: -5,
      }] },
    });
    expect(neg.status).toBe(400);
  });

  it('sell-orders PATCH rejects qty=0 / negative unitPrice', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
    const customerId = customers.body.items[0].id;
    const created = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{
        inventoryId: line.id, category: 'RAM', label: 'x',
        partNumber: 'pn', qty: 1, unitPrice: line.sell_price,
      }] },
    });
    const soId = created.body.id;
    const bad = await api('PATCH', `/api/sell-orders/${soId}`, {
      token,
      body: { lines: [{
        inventoryId: line.id, category: 'RAM', label: 'x',
        partNumber: 'pn', qty: 0, unitPrice: line.sell_price,
      }] },
    });
    expect(bad.status).toBe(400);
  });
});
