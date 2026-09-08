// The Ready to Pay stage: review finished, commission owed, Done still to
// come. Lines share Done's inventory status, so the stock and sellable buckets
// never learn a fifth value, and the book closes here rather than at Done.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS } from './helpers/auth';

const BODY = {
  paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1',
  lines: [{ category: 'RAM', qty: 2, unitCost: 10, condition: 'New', sellPrice: 40 }],
};
const FROM = { name: 'Jordan Rivera', street1: '2210 E Speedway Blvd', city: 'Tucson', state: 'AZ', zip: '85719' };
const PKG = { weightOz: 32, lengthIn: 10, widthIn: 8, heightIn: 6 };

type Order = { lifecycle: string; status: string; lines: { id: string; status: string }[] };

async function getOrder(token: string, id: string): Promise<Order> {
  const r = await api<{ order: Order }>('GET', `/api/orders/${id}`, { token });
  expect(r.status).toBe(200);
  return r.body.order;
}

async function advance(token: string, id: string, toStage?: string) {
  return api<{ lifecycle?: string; error?: string }>('POST', `/api/orders/${id}/advance`, {
    token, body: toStage ? { toStage } : {},
  });
}

// A PO owned by Marcus, moved by Alex to the requested stage.
async function orderAt(stage: 'reviewing' | 'ready_to_pay' | 'done') {
  const marcus = await loginAs(MARCUS);
  const alex = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/orders', { token: marcus.token, body: BODY });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await advance(marcus.token, id)).status).toBe(200);         // → in_transit
  expect((await advance(alex.token, id)).status).toBe(200);           // → reviewing
  if (stage !== 'reviewing') expect((await advance(alex.token, id)).status).toBe(200);   // → ready_to_pay
  if (stage === 'done') expect((await advance(alex.token, id)).status).toBe(200);        // → done
  return { id, marcus, alex };
}

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

describe('Ready to Pay sits between Reviewing and Done', () => {
  beforeEach(async () => { await resetDb(); });

  it('a bodiless manager advance from Reviewing lands on ready_to_pay with Done lines, then Done, then nothing', async () => {
    const { id, alex } = await orderAt('reviewing');

    const r = await advance(alex.token, id);
    expect(r.status).toBe(200);
    expect(r.body.lifecycle).toBe('ready_to_pay');

    const order = await getOrder(alex.token, id);
    expect(order.lifecycle).toBe('ready_to_pay');
    expect(order.status).toBe('Ready to Pay');
    expect(order.lines.every(l => l.status === 'Done')).toBe(true);

    const ev = await api<{ events: { kind: string; detail: { from?: string; to?: string } }[] }>(
      'GET', `/api/orders/${id}/events`, { token: alex.token });
    expect(ev.body.events.some(e => e.kind === 'advanced' && e.detail.from === 'reviewing' && e.detail.to === 'ready_to_pay')).toBe(true);

    expect((await advance(alex.token, id)).body.lifecycle).toBe('done');
    expect((await advance(alex.token, id)).status).toBe(409);
  });

  it('a purchaser cannot take the order from Reviewing to Ready to Pay', async () => {
    const { id, marcus } = await orderAt('reviewing');
    expect((await advance(marcus.token, id)).status).toBe(403);
  });

  it('the list reports the stage label and keeps it when Done is hidden', async () => {
    const { id, alex } = await orderAt('ready_to_pay');

    const byStatus = await api<{ orders: { id: string; status: string }[] }>(
      'GET', '/api/orders?status=Ready%20to%20Pay', { token: alex.token });
    expect(byStatus.body.orders.map(o => o.id)).toContain(id);
    expect(byStatus.body.orders.find(o => o.id === id)?.status).toBe('Ready to Pay');

    const hideDone = await api<{ orders: { id: string }[] }>(
      'GET', '/api/orders?excludeStatus=Done', { token: alex.token });
    expect(hideDone.body.orders.map(o => o.id)).toContain(id);
  });

  it('entering Ready to Pay notifies the managers and the owner; a reopen into it does not', async () => {
    const { id, alex, marcus } = await orderAt('reviewing');
    const sofia = await loginAs(SOFIA);
    const before = await api<{ unreadCount: number }>('GET', '/api/notifications', { token: marcus.token });

    expect((await advance(alex.token, id)).status).toBe(200);

    for (const who of [marcus, sofia]) {
      const after = await api<{ unreadCount: number; items: { kind: string }[] }>(
        'GET', '/api/notifications', { token: who.token });
      expect(after.body.items.some(i => i.kind === 'order_ready_to_pay')).toBe(true);
    }
    const owner = await api<{ unreadCount: number }>('GET', '/api/notifications', { token: marcus.token });
    expect(owner.body.unreadCount).toBe(before.body.unreadCount + 1);

    expect((await advance(alex.token, id)).status).toBe(200);                 // → done
    expect((await advance(alex.token, id, 'ready_to_pay')).status).toBe(200); // reopen
    const again = await api<{ unreadCount: number }>('GET', '/api/notifications', { token: marcus.token });
    expect(again.body.unreadCount).toBe(owner.body.unreadCount);
  });
});

describe('moves between Reviewing, Ready to Pay and Done', () => {
  beforeEach(async () => { await resetDb(); });

  it('Ready to Pay ↔ Done both succeed while a Done line sits on an open sell order; back to Reviewing refuses', async () => {
    const { id, alex } = await orderAt('ready_to_pay');
    const order = await getOrder(alex.token, id);
    const customerId = await firstCustomerId(alex.token);
    const so = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: alex.token,
      body: { customerId, lines: [{ inventoryId: order.lines[0].id, category: 'RAM', label: 'x',
        partNumber: 'pn', qty: 1, unitPrice: 50 }] },
    });
    expect(so.status).toBe(201);

    expect((await advance(alex.token, id)).body.lifecycle).toBe('done');
    expect((await advance(alex.token, id, 'ready_to_pay')).body.lifecycle).toBe('ready_to_pay');
    const back = await advance(alex.token, id, 'reviewing');
    expect(back.status).toBe(409);
    expect(back.body.error).toMatch(/committed/i);
    expect((await getOrder(alex.token, id)).lines[0].status).toBe('Done');
  });

  it('a manager may still jump Reviewing → Done, and reopen Done → Reviewing', async () => {
    const { id, alex } = await orderAt('reviewing');
    expect((await advance(alex.token, id, 'done')).body.lifecycle).toBe('done');
    expect((await advance(alex.token, id, 'reviewing')).body.lifecycle).toBe('reviewing');
    expect((await getOrder(alex.token, id)).lines.every(l => l.status === 'Reviewing')).toBe(true);
  });
});

describe('the book closes at Ready to Pay', () => {
  beforeEach(async () => { await resetDb(); });

  it('the purchaser is read-only, notes included', async () => {
    const { id, marcus } = await orderAt('ready_to_pay');
    const r = await api('PATCH', `/api/orders/${id}`, { token: marcus.token, body: { notes: 'late receipt' } });
    expect(r.status).toBe(403);
    const meta = await api('PUT', `/api/orders/${id}/status-meta/Submission`, {
      token: marcus.token, body: { note: 'receipt' } });
    expect(meta.status).toBe(403);
  });

  it('a manager may append a note but not touch costs, lines or ownership', async () => {
    const { id, alex, marcus } = await orderAt('ready_to_pay');
    expect((await api('PATCH', `/api/orders/${id}`, { token: alex.token, body: { notes: 'ok' } })).status).toBe(200);

    const fees = await api<{ error: string }>('PATCH', `/api/orders/${id}`, { token: alex.token, body: { otherFees: 5 } });
    expect(fees.status).toBe(409);
    expect(fees.body.error).toMatch(/Ready to Pay/);
    expect((await api('PATCH', `/api/orders/${id}`, { token: alex.token, body: { onBehalfOfUserId: marcus.user.id } })).status).toBe(409);
  });

  it('shipments and goods edits on the lines refuse', async () => {
    const { id, alex } = await orderAt('ready_to_pay');
    const ship = await api('POST', `/api/orders/${id}/shipments`, { token: alex.token, body: { from: FROM, package: PKG } });
    expect(ship.status).toBe(409);

    const line = (await getOrder(alex.token, id)).lines[0];
    const qty = await api<{ error: string }>('PATCH', `/api/inventory/${line.id}`, { token: alex.token, body: { qty: 5 } });
    expect(qty.status).toBe(409);
    expect(qty.body.error).toMatch(/past review/i);
  });
});

describe('line status stays the inventory vocabulary', () => {
  beforeEach(async () => { await resetDb(); });

  it('a stage label is not a line status', async () => {
    const { id, alex } = await orderAt('reviewing');
    const line = (await getOrder(alex.token, id)).lines[0];
    const r = await api<{ error: string }>('PATCH', `/api/inventory/${line.id}`, {
      token: alex.token, body: { status: 'Ready to Pay' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/status must be one of/);
    expect((await api('PATCH', `/api/inventory/${line.id}`, { token: alex.token, body: { status: 'Done' } })).status).toBe(200);
  });
});
