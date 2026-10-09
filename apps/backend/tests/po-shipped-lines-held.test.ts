// A PO moved back to Reviewing while some of its lines sit on a Shipped or
// Awaiting-payment sell order: those lines stay Done and view-only, the rest
// become editable. Draft sell orders keep blocking only what they did before.
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { createSellOrderOn } from './helpers/fixtures';

const BODY = {
  paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1',
  lines: [
    { category: 'RAM', qty: 2, unitCost: 10, condition: 'New', sellPrice: 40, partNumber: 'HELD-A' },
    { category: 'RAM', qty: 3, unitCost: 20, condition: 'New', sellPrice: 50, partNumber: 'HELD-B' },
  ],
};

type Line = { id: string; status: string; partNumber: string; unitCost: number; shippedOn?: string[] };
type Order = { lifecycle: string; lines: Line[] };

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

async function setSellStatus(token: string, soId: string, to: string) {
  const body = to === 'Closed' ? { to, note: 'x', closeReasonId: 'customer_cancelled' } : { to, note: 'x' };
  expect((await api('POST', `/api/sell-orders/${soId}/status`, { token, body })).status).toBe(200);
}

// Marcus's two-line PO, taken by Alex to `stage`.
async function twoLineOrder(stage: 'reviewing' | 'ready_to_pay') {
  const marcus = await loginAs(MARCUS);
  const alex = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/orders', { token: marcus.token, body: BODY });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await advance(marcus.token, id)).status).toBe(200);
  expect((await advance(alex.token, id)).status).toBe(200);
  if (stage === 'ready_to_pay') expect((await advance(alex.token, id)).status).toBe(200);
  const lines = (await getOrder(alex.token, id)).lines;
  const a = lines.find(l => l.partNumber === 'HELD-A')!;
  const b = lines.find(l => l.partNumber === 'HELD-B')!;
  return { id, alex, marcus, a, b };
}

// A on an Awaiting-payment sell order, B on a Draft one, then back to Reviewing.
async function heldOrder() {
  const o = await twoLineOrder('ready_to_pay');
  const shipped = await createSellOrderOn(o.alex.token, o.a.id, 'HELD-A');
  await setSellStatus(o.alex.token, shipped, 'Awaiting payment');
  const draft = await createSellOrderOn(o.alex.token, o.b.id, 'HELD-B');
  const back = await advance(o.alex.token, o.id, 'reviewing');
  expect(back.status).toBe(200);
  expect(back.body.lifecycle).toBe('reviewing');
  return { ...o, shipped, draft };
}

describe('a PO back in Reviewing with shipped products', () => {
  beforeEach(async () => { await resetDb(); });

  it('the move goes through; the shipped line stays Done, the rest go to Reviewing', async () => {
    const { id, alex, a, b } = await heldOrder();
    const lines = (await getOrder(alex.token, id)).lines;
    expect(lines.find(l => l.id === a.id)!.status).toBe('Done');
    expect(lines.find(l => l.id === b.id)!.status).toBe('Reviewing');
  });

  it('PATCH edits the free line, refuses a change to the held one, and ignores an unchanged echo of it', async () => {
    const { id, alex, a, b, shipped } = await heldOrder();

    const free = await api('PATCH', `/api/orders/${id}`, {
      token: alex.token, body: { lines: [{ id: b.id, unitCost: 21 }] },
    });
    expect(free.status).toBe(200);

    const held = await api<{ error: string; offendingLineIds: string[]; sellOrderIds: string[] }>(
      'PATCH', `/api/orders/${id}`, { token: alex.token, body: { lines: [{ id: a.id, unitCost: 11 }] } });
    expect(held.status).toBe(409);
    expect(held.body.error).toMatch(/view-only/);
    expect(held.body.offendingLineIds).toEqual([a.id.toLowerCase()]);
    expect(held.body.sellOrderIds).toEqual([shipped]);

    const echo = await api('PATCH', `/api/orders/${id}`, {
      token: alex.token, body: { lines: [{ id: a.id, unitCost: 10, partNumber: 'HELD-A' }, { id: b.id, unitCost: 22 }] },
    });
    expect(echo.status).toBe(200);

    const lines = (await getOrder(alex.token, id)).lines;
    expect(lines.find(l => l.id === a.id)!.unitCost).toBe(10);
    expect(lines.find(l => l.id === b.id)!.unitCost).toBe(22);
  });

  it('the inventory editor keeps the held lot\'s qty and cost, not its sell price', async () => {
    const { alex, a } = await heldOrder();
    const cost = await api<{ error: string }>('PATCH', `/api/inventory/${a.id}`, {
      token: alex.token, body: { unitCost: 11 },
    });
    expect(cost.status).toBe(409);
    expect(cost.body.error).toMatch(/shipped sell order/);
    expect((await api('PATCH', `/api/inventory/${a.id}`, {
      token: alex.token, body: { sellPrice: 45 },
    })).status).toBe(200);
  });

  it('GET names the holding sell order to a manager, on the held line only', async () => {
    const { id, alex, marcus, a, b, shipped } = await heldOrder();
    const mgrLines = (await getOrder(alex.token, id)).lines;
    expect(mgrLines.find(l => l.id === a.id)!.shippedOn).toEqual([shipped]);
    expect(mgrLines.find(l => l.id === b.id)!).not.toHaveProperty('shippedOn');
    const purLines = (await getOrder(marcus.token, id)).lines;
    for (const l of purLines) expect(l).not.toHaveProperty('shippedOn');
  });

  it('In Transit and the purchaser revert are still refused', async () => {
    const { id, alex, marcus, b } = await heldOrder();
    expect((await advance(alex.token, id, 'in_transit')).status).toBe(409);
    const revert = await api('PATCH', `/api/orders/${id}`, {
      token: marcus.token, body: { lines: [{ id: b.id, qty: 4 }] },
    });
    expect(revert.status).toBe(409);
    expect((await getOrder(alex.token, id)).lifecycle).toBe('reviewing');
  });

  it('once the sell order closes the line is free again — still Done until the PO advances', async () => {
    const { id, alex, a, shipped } = await heldOrder();
    await setSellStatus(alex.token, shipped, 'Closed');

    const after = (await getOrder(alex.token, id)).lines.find(l => l.id === a.id)!;
    expect(after).not.toHaveProperty('shippedOn');
    expect(after.status).toBe('Done');
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: alex.token, body: { lines: [{ id: a.id, unitCost: 11 }] },
    })).status).toBe(200);

    expect((await advance(alex.token, id)).body.lifecycle).toBe('ready_to_pay');
    expect((await getOrder(alex.token, id)).lines.every(l => l.status === 'Done')).toBe(true);
  });

  it('a Reviewing line shipped on the way forward stays editable', async () => {
    const { id, alex, a } = await twoLineOrder('reviewing');
    const so = await createSellOrderOn(alex.token, a.id, 'HELD-A');
    await setSellStatus(alex.token, so, 'Awaiting payment');
    expect((await api('PATCH', `/api/orders/${id}`, {
      token: alex.token, body: { lines: [{ id: a.id, unitCost: 11 }] },
    })).status).toBe(200);
  });
});
