import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

async function sellableLine(token: string, minQty = 1): Promise<{ id: string; qty: number; price: number }> {
  const l = await freeSellableLine(token, minQty);
  return { id: l.id, qty: l.qty, price: l.sell_price };
}

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

async function lineQty(token: string, id: string): Promise<number> {
  const r = await api<{ item: { qty: number } }>('GET', `/api/inventory/${id}`, { token });
  return r.body.item.qty;
}

async function driveToDone(token: string, soId: string) {
  await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Shipped', note: 's' } });
  await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Awaiting payment', note: 'a' } });
  return api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Done', note: 'paid' } });
}

describe('Tier 1 #3 — closing a sell order decrements inventory qty', () => {
  beforeEach(async () => { await resetDb(); });

  it('subtracts the sold qty from the source order_line on Done', async () => {
    const { token } = await loginAs(ALEX);
    const line = await sellableLine(token, 2);
    const customerId = await firstCustomerId(token);

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x',
        partNumber: 'pn', qty: 2, unitPrice: line.price }] },
    });
    expect(create.status).toBe(201);

    expect(await lineQty(token, line.id)).toBe(line.qty); // unchanged while open
    const done = await driveToDone(token, create.body.id);
    expect(done.status).toBe(200);

    expect(await lineQty(token, line.id)).toBe(line.qty - 2);
  });
});

describe('Tier 1 #2 — Done→Done is idempotent', () => {
  beforeEach(async () => { await resetDb(); });

  it('re-POSTing Done does not decrement qty again or duplicate sold events', async () => {
    const { token } = await loginAs(ALEX);
    const line = await sellableLine(token, 2);
    const customerId = await firstCustomerId(token);

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x',
        partNumber: 'pn', qty: 1, unitPrice: line.price }] },
    });
    const soId = create.body.id;
    expect((await driveToDone(token, soId)).status).toBe(200);

    const afterFirst = await lineQty(token, line.id);
    expect(afterFirst).toBe(line.qty - 1);

    const events1 = await api<{ events: { kind: string }[] }>('GET', `/api/inventory/${line.id}`, { token });
    const soldCount1 = events1.body.events.filter((e: { kind: string }) => e.kind === 'sold').length;

    // Replay the terminal transition — must be a no-op.
    const replay = await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Done', note: 'paid again' } });
    expect(replay.status).toBe(200);

    expect(await lineQty(token, line.id)).toBe(afterFirst); // not decremented twice
    const events2 = await api<{ events: { kind: string }[] }>('GET', `/api/inventory/${line.id}`, { token });
    const soldCount2 = events2.body.events.filter((e: { kind: string }) => e.kind === 'sold').length;
    expect(soldCount2).toBe(soldCount1); // no duplicate audit row
  });
});

describe('Tier 1 #4 — order_lines committed to an open sell order are locked', () => {
  beforeEach(async () => { await resetDb(); });

  it('rejects qty and status edits on a line referenced by a non-Done sell order', async () => {
    const { token } = await loginAs(ALEX);
    const line = await sellableLine(token, 2);
    const customerId = await firstCustomerId(token);

    await api('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x',
        partNumber: 'pn', qty: 1, unitPrice: line.price }] },
    });

    const qtyEdit = await api('PATCH', `/api/inventory/${line.id}`, { token, body: { qty: 1 } });
    expect(qtyEdit.status).toBe(409);
    const statusEdit = await api('PATCH', `/api/inventory/${line.id}`, { token, body: { status: 'In Transit' } });
    expect(statusEdit.status).toBe(409);

    // A non-conflicting field is still editable.
    const priceEdit = await api('PATCH', `/api/inventory/${line.id}`, { token, body: { sellPrice: line.price + 1 } });
    expect(priceEdit.status).toBe(200);

    // qty unchanged by the rejected edits.
    expect(await lineQty(token, line.id)).toBe(line.qty);
  });

  it('allows qty/status edits on a line with no sell-order linkage', async () => {
    const { token } = await loginAs(ALEX);
    const line = await sellableLine(token, 2);
    const r = await api('PATCH', `/api/inventory/${line.id}`, { token, body: { qty: line.qty - 1 } });
    expect(r.status).toBe(200);
    expect(await lineQty(token, line.id)).toBe(line.qty - 1);
  });
});

describe('Tier 1 #1 — one active sell order per inventory line (oversell guard)', () => {
  beforeEach(async () => { await resetDb(); });

  async function newSellOrder(token: string, lineId: string, price: number, qty = 1) {
    const customerId = await firstCustomerId(token);
    return api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: lineId, category: 'RAM', label: 'x',
        partNumber: 'pn', qty, unitPrice: price }] },
    });
  }

  it('POST rejects a line already on another open sell order', async () => {
    const { token } = await loginAs(ALEX);
    const line = await sellableLine(token, 2);

    const first = await newSellOrder(token, line.id, line.price);
    expect(first.status).toBe(201);

    const second = await newSellOrder(token, line.id, line.price);
    expect(second.status).toBe(400);
    // The message names the product and the order it's already on — not a raw
    // inventory UUID — so the user can act on it.
    const msg = (second.body as { error?: string }).error ?? JSON.stringify(second.body);
    expect(msg).toContain('x (pn) is already on sell order');
    expect(msg).toContain(first.body.id);
  });

  it('PATCH may keep its own already-committed line (self excluded)', async () => {
    const { token } = await loginAs(ALEX);
    const line = await sellableLine(token, 2);
    const first = await newSellOrder(token, line.id, line.price);
    const soId = first.body.id;

    const patch = await api('PATCH', `/api/sell-orders/${soId}`, {
      token,
      body: { lines: [{ inventoryId: line.id, category: 'RAM', label: 'edited',
        partNumber: 'pn', qty: 1, unitPrice: line.price }] },
    });
    expect(patch.status).toBe(200);
  });

  it('a closed (Done) sell order frees the line for the remaining qty', async () => {
    const { token } = await loginAs(ALEX);
    const line = await sellableLine(token, 3);
    const first = await newSellOrder(token, line.id, line.price, 1);
    expect((await driveToDone(token, first.body.id)).status).toBe(200);
    expect(await lineQty(token, line.id)).toBe(line.qty - 1);

    // Done order no longer "holds" the line — remaining stock is sellable.
    const again = await newSellOrder(token, line.id, line.price, 1);
    expect(again.status).toBe(201);
  });

  it('purchaser-submitted line cannot be oversold by exceeding available qty', async () => {
    const { token } = await loginAs(ALEX);
    const line = await sellableLine(token, 2);
    const customerId = await firstCustomerId(token);
    const r = await api('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x',
        partNumber: 'pn', qty: line.qty + 1, unitPrice: line.price }] },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/qty/i);
  });
});
