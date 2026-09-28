// A sell order holds the PO lines it names only while it is open (Draft,
// Shipped, Awaiting payment) and not archived. Removing a line that only
// Closed, Done or archived sell orders still point at succeeds and leaves
// those sell orders their snapshot with the link cleared; an open sell order
// refuses the removal and is named in the 409.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { createSellOrderOn } from './helpers/fixtures';

type Line = { id: string; status: string; qty: number };
type Detail = { order: { lines: Line[] } };
type Conflict = { error: string; offendingLineIds?: string[]; sellOrderIds?: string[] };

const PN = 'RMLINE-TEST-PN';

async function createReviewing(pur: string, mgr: string): Promise<{ id: string; lineIds: string[] }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000002',
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

const get = (id: string, token: string) => api<Detail>('GET', `/api/orders/${id}`, { token });

async function moveSellOrder(mgr: string, soId: string, to: string): Promise<void> {
  // Closing needs a structured reason; every other move takes just a note.
  const body = to === 'Closed' ? { to, note: 'x', closeReasonId: 'customer_cancelled' } : { to, note: 'x' };
  expect((await api('POST', `/api/sell-orders/${soId}/status`, { token: mgr, body })).status).toBe(200);
}

async function sellLinesOf(soId: string): Promise<{ inventory_id: string | null; label: string; qty: number }[]> {
  return getTestDb()<{ inventory_id: string | null; label: string; qty: number }[]>`
    SELECT inventory_id, label, qty FROM sell_order_lines WHERE sell_order_id = ${soId}
  `;
}

describe('removing a PO line named by a sell order', () => {
  beforeEach(async () => { await resetDb(); });

  it('succeeds when the only sell order naming it is archived, and the sell order keeps its snapshot', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0], PN);
    await moveSellOrder(mgr, soId, 'Shipped');
    expect((await api('POST', `/api/sell-orders/${soId}/archive`, { token: mgr })).status).toBe(200);

    const res = await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { removeLineIds: [lineIds[0]] } });
    expect(res.status).toBe(200);

    expect((await get(id, mgr)).body.order.lines.map(l => l.id)).toEqual([lineIds[1]]);
    expect(await sellLinesOf(soId)).toEqual([{ inventory_id: null, label: 'x', qty: 1 }]);
  });

  it('still refuses while a non-archived sell order names it, and says which one', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0], PN);
    await moveSellOrder(mgr, soId, 'Shipped');

    const res = await api<Conflict>('PATCH', `/api/orders/${id}`, { token: mgr, body: { removeLineIds: [lineIds[0]] } });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(soId);
    expect(res.body.offendingLineIds).toEqual([lineIds[0]]);
    expect(res.body.sellOrderIds).toEqual([soId]);

    expect((await get(id, mgr)).body.order.lines.map(l => l.id).sort()).toEqual([...lineIds].sort());
    expect((await sellLinesOf(soId))[0].inventory_id).toBe(lineIds[0]);
  });

  it('removes a Sold line once the sell order that consumed it is Done', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[1], PN, 2);
    await moveSellOrder(mgr, soId, 'Done');
    const sold = (await get(id, mgr)).body.order.lines.find(l => l.id === lineIds[1]);
    expect(sold?.status).toBe('Sold');

    // Done consumed the stock; the sale keeps its snapshot and the line may go.
    expect((await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { removeLineIds: [lineIds[1]] } })).status).toBe(200);

    expect((await get(id, mgr)).body.order.lines.map(l => l.id)).toEqual([lineIds[0]]);
    expect(await sellLinesOf(soId)).toEqual([{ inventory_id: null, label: 'x', qty: 2 }]);
  });

  it('succeeds when the only sell order naming it is Closed, and the sell order keeps its snapshot', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0], PN);
    await moveSellOrder(mgr, soId, 'Shipped');
    await moveSellOrder(mgr, soId, 'Closed');

    const res = await api('PATCH', `/api/orders/${id}`, { token: mgr, body: { removeLineIds: [lineIds[0]] } });
    expect(res.status).toBe(200);

    expect((await get(id, mgr)).body.order.lines.map(l => l.id)).toEqual([lineIds[1]]);
    expect(await sellLinesOf(soId)).toEqual([{ inventory_id: null, label: 'x', qty: 1 }]);
  });

  it('still refuses while a Draft sell order names it', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0], PN);

    const res = await api<Conflict>('PATCH', `/api/orders/${id}`, { token: mgr, body: { removeLineIds: [lineIds[0]] } });
    expect(res.status).toBe(409);
    expect(res.body.sellOrderIds).toEqual([soId]);
    expect((await sellLinesOf(soId))[0].inventory_id).toBe(lineIds[0]);
  });
});
