// A PO line's final sell price is the qty-weighted average unit price over
// the Done sell orders that name it — the price the units actually sold for,
// distinct from the projected `sellPrice` that feeds commission. Managers
// only: everyone else, including the PO's owner and a manager previewing as
// purchaser, gets no key at all — a null would still name the feature.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { createSellOrderOn } from './helpers/fixtures';

type Line = {
  id: string; status: string; qty: number;
  finalSellPrice?: number | null; finalSoldQty?: number | null;
};
type Detail = { order: { lines: Line[] } };

const PN = 'FSP-TEST-PN';

async function createReviewing(pur: string, mgr: string): Promise<{ id: string; lineIds: string[] }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000003',
      category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: [
        { category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN, condition: 'Pulled — Tested', qty: 4, unitCost: 78.5 },
        { category: 'RAM', brand: 'Samsung', capacity: '16GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: PN, condition: 'Pulled — Tested', qty: 2, unitCost: 40 },
      ],
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  expect((await api('POST', `/api/orders/${id}/advance`, {
    token: mgr, body: { toStage: 'reviewing' },
  })).status).toBe(200);
  const got = await api<Detail>('GET', `/api/orders/${id}`, { token: mgr });
  return { id, lineIds: got.body.order.lines.map(l => l.id) };
}

async function lineOf(id: string, token: string, lineId: string): Promise<Line> {
  const res = await api<Detail>('GET', `/api/orders/${id}`, { token });
  expect(res.status).toBe(200);
  const line = res.body.order.lines.find(l => l.id === lineId);
  expect(line).toBeDefined();
  return line!;
}

async function moveSellOrder(mgr: string, soId: string, to: string): Promise<void> {
  const body = to === 'Closed' ? { to, note: 'x', closeReasonId: 'customer_cancelled' } : { to, note: 'x' };
  expect((await api('POST', `/api/sell-orders/${soId}/status`, { token: mgr, body })).status).toBe(200);
}

describe('final sell price on PO lines', () => {
  beforeEach(async () => { await resetDb(); });

  it('is null until a sell order naming the line is Done', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);

    let line = await lineOf(id, mgr, lineIds[0]);
    expect(line.finalSellPrice).toBeNull();
    expect(line.finalSoldQty).toBeNull();

    const soId = await createSellOrderOn(mgr, lineIds[0], PN, 1, 90);
    line = await lineOf(id, mgr, lineIds[0]);
    expect(line.finalSellPrice).toBeNull();

    await moveSellOrder(mgr, soId, 'Shipped');
    line = await lineOf(id, mgr, lineIds[0]);
    expect(line.finalSellPrice).toBeNull();

    await moveSellOrder(mgr, soId, 'Done');
    line = await lineOf(id, mgr, lineIds[0]);
    expect(line.finalSellPrice).toBe(90);
    expect(line.finalSoldQty).toBe(1);
    // A partial sale leaves the remainder on the line — the sold count is
    // what the price is read against.
    expect(line.qty).toBe(3);
    expect(line.status).not.toBe('Sold');
  });

  it('averages across several Done sell orders by qty and ignores Closed ones', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);

    const first = await createSellOrderOn(mgr, lineIds[0], PN, 1, 90);
    await moveSellOrder(mgr, first, 'Done');
    const second = await createSellOrderOn(mgr, lineIds[0], PN, 2, 100);
    await moveSellOrder(mgr, second, 'Done');
    const cancelled = await createSellOrderOn(mgr, lineIds[0], PN, 1, 500);
    await moveSellOrder(mgr, cancelled, 'Closed');

    const line = await lineOf(id, mgr, lineIds[0]);
    expect(line.finalSellPrice).toBeCloseTo((90 + 200) / 3, 2);
    expect(line.finalSoldQty).toBe(3);

    // The untouched sibling line is still unsold.
    const other = await lineOf(id, mgr, lineIds[1]);
    expect(other.finalSellPrice).toBeNull();
    expect(other.finalSoldQty).toBeNull();
  });

  it('is absent for the owning purchaser and for a manager previewing as purchaser', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[1], PN, 2, 60);
    await moveSellOrder(mgr, soId, 'Done');

    const asManager = await lineOf(id, mgr, lineIds[1]);
    expect(asManager.finalSellPrice).toBe(60);
    expect(asManager.status).toBe('Sold');

    const asOwner = await lineOf(id, pur, lineIds[1]);
    expect(asOwner).not.toHaveProperty('finalSellPrice');
    expect(asOwner).not.toHaveProperty('finalSoldQty');

    // Previewing as purchaser also narrows reads to the manager's own POs,
    // so the preview case needs a PO the manager owns.
    const own = await createReviewing(mgr, mgr);
    const ownSo = await createSellOrderOn(mgr, own.lineIds[0], PN, 1, 75);
    await moveSellOrder(mgr, ownSo, 'Done');
    expect((await lineOf(own.id, mgr, own.lineIds[0])).finalSellPrice).toBe(75);

    expect((await api('PATCH', '/api/me/preferences', {
      token: mgr, body: { 'tweaks.rolePreview': 'as_purchaser' },
    })).status).toBe(200);
    const previewing = await lineOf(own.id, mgr, own.lineIds[0]);
    expect(previewing).not.toHaveProperty('finalSellPrice');
    expect(previewing).not.toHaveProperty('finalSoldQty');
  });
});

type SoRef = { id: string; customer: string; qty: number };
type SoDetail = { order: { lines: { inventoryId: string | null; sourceOrderId: string | null }[] } };

describe('a PO and the sell orders that sold it link to each other', () => {
  beforeEach(async () => { await resetDb(); });

  it('lists the Done sell orders naming its lines, managers only', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);

    const done = await createSellOrderOn(mgr, lineIds[0], PN, 1, 90);
    await moveSellOrder(mgr, done, 'Done');
    const other = await createSellOrderOn(mgr, lineIds[1], PN, 2, 60);
    await moveSellOrder(mgr, other, 'Done');
    // Draft and Shipped orders only claim units; they have not sold them.
    await createSellOrderOn(mgr, lineIds[0], PN, 1, 95);
    const shipped = await createSellOrderOn(mgr, lineIds[0], PN, 1, 99);
    await moveSellOrder(mgr, shipped, 'Shipped');

    const asManager = await api<{ order: { sellOrders: SoRef[] | null } }>('GET', `/api/orders/${id}`, { token: mgr });
    const refs = asManager.body.order.sellOrders!;
    expect(refs.map(r => r.id).sort()).toEqual([done, other].sort());
    expect(refs.find(r => r.id === other)!.qty).toBe(2);
    expect(typeof refs[0].customer).toBe('string');

    const asOwner = await api<{ order: { sellOrders?: SoRef[] | null } }>('GET', `/api/orders/${id}`, { token: pur });
    expect(asOwner.body.order).not.toHaveProperty('sellOrders');
  });

  it('names each sell order line\'s source PO', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0], PN, 1, 90);

    const so = await api<SoDetail>('GET', `/api/sell-orders/${soId}`, { token: mgr });
    expect(so.status).toBe(200);
    expect(so.body.order.lines[0].inventoryId).toBe(lineIds[0]);
    expect(so.body.order.lines[0].sourceOrderId).toBe(id);
  });
});
