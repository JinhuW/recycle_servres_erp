import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { firstCustomerId, signOffAll } from './helpers/fixtures';

async function lineStatus(token: string, id: string): Promise<string> {
  const r = await api<{ item: { status: string } }>('GET', `/api/inventory/${id}`, { token });
  return r.body.item.status;
}

async function lineQty(token: string, id: string): Promise<number> {
  const r = await api<{ item: { qty: number } }>('GET', `/api/inventory/${id}`, { token });
  return r.body.item.qty;
}

async function driveToDone(token: string, soId: string) {
  await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Shipped', note: 's' } });
  await api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Awaiting payment', note: 'a' } });
  await signOffAll(soId);
  return api('POST', `/api/sell-orders/${soId}/status`, { token, body: { to: 'Done', note: 'paid' } });
}

async function sell(token: string, lineId: string, qty: number, price: number): Promise<string> {
  const customerId = await firstCustomerId(token);
  const create = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: { customerId, lines: [{ inventoryId: lineId, category: 'RAM', label: 'x',
      partNumber: 'pn', qty, unitPrice: price }] },
  });
  expect(create.status).toBe(201);
  return create.body.id;
}

describe('PO line flips to Sold only when fully consumed', () => {
  beforeEach(async () => { await resetDb(); });

  it('full-qty sale on a closed sell order flips the line to Sold', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);

    const soId = await sell(token, line.id, line.qty, line.sell_price);
    expect(await driveToDone(token, soId)).toMatchObject({ status: 200 });

    // qty has a CHECK (qty > 0) constraint, so a sold-out line keeps its lot
    // size and the Sold status is the sole "no stock" signal.
    expect(await lineStatus(token, line.id)).toBe('Sold');
    expect(await lineQty(token, line.id)).toBe(line.qty);

    const inv = await api<{ events: Array<{ kind: string; detail: { remainingQty?: number } }> }>(
      'GET', `/api/inventory/${line.id}`, { token });
    const soldEvent = inv.body.events.find(e => e.kind === 'sold');
    expect(soldEvent?.detail.remainingQty).toBe(0);
  });

  it('partial sale leaves the line below Sold and still sellable', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 2);
    const before = await lineStatus(token, line.id);

    const soId = await sell(token, line.id, line.qty - 1, line.sell_price);
    expect(await driveToDone(token, soId)).toMatchObject({ status: 200 });

    expect(await lineQty(token, line.id)).toBe(1);
    expect(await lineStatus(token, line.id)).toBe(before);
    expect(before).not.toBe('Sold');
  });

  it('re-advancing the PO does not resurrect a Sold line', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const inv = await api<{ item: { order_id: string } }>(
      'GET', `/api/inventory/${line.id}`, { token });
    const orderId = inv.body.item.order_id;

    const soId = await sell(token, line.id, line.qty, line.sell_price);
    expect(await driveToDone(token, soId)).toMatchObject({ status: 200 });
    expect(await lineStatus(token, line.id)).toBe('Sold');

    const adv = await api('POST', `/api/orders/${orderId}/advance`, {
      token, body: { toStage: 'done' },
    });
    expect(adv.status).toBe(200);
    expect(await lineStatus(token, line.id)).toBe('Sold');
  });
});

describe('sold inventory events', () => {
  beforeEach(async () => { await resetDb(); });

  it('writes one sold event per consumed line, with the detail keys readers expect', async () => {
    const { token, user } = await loginAs(ALEX);
    const full = await freeSellableLine(token, 1);
    const partial = await freeSellableLine(token, 2, new Set([full.id]));
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [
        { inventoryId: full.id, category: 'RAM', label: 'a', partNumber: 'pn-a',
          qty: full.qty, unitPrice: full.sell_price },
        { inventoryId: partial.id, category: 'RAM', label: 'b', partNumber: 'pn-b',
          qty: partial.qty - 1, unitPrice: partial.sell_price },
      ] },
    });
    expect(create.status).toBe(201);
    const soId = create.body.id;
    expect(await driveToDone(token, soId)).toMatchObject({ status: 200 });

    const rows = await getTestDb()<{ order_line_id: string; actor_id: string; detail: unknown }[]>`
      SELECT order_line_id, actor_id, detail FROM inventory_events
      WHERE kind = 'sold' AND order_line_id IN (${full.id}, ${partial.id})`;
    expect(rows).toHaveLength(2);
    const byLine = new Map(rows.map((r) => [r.order_line_id, r]));
    expect(byLine.get(full.id)?.detail).toEqual({ soldQty: full.qty, remainingQty: 0, sellOrder: soId });
    expect(byLine.get(partial.id)?.detail).toEqual({
      soldQty: partial.qty - 1, remainingQty: 1, sellOrder: soId,
    });
    for (const r of rows) expect(r.actor_id).toBe(user.id);
  });
});
