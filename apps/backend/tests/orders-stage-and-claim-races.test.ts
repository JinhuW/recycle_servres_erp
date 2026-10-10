// Writes on a PO that a sell order or a stale page can race:
// - removing or archiving a line whose 0-held sell line is being raised,
// - a PATCH naming the stage it saw (`expectStage`),
// - a forward move into Reviewing over a lot already on a shipped sale,
// - a purchaser's lot edit through the inventory editor on a submitted PO.

import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { createSellOrderOn } from './helpers/fixtures';

const PN = 'RACE-TEST-PN';

async function createPo(pur: string): Promise<{ id: string; lineIds: string[] }> {
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
  const lines = await getTestDb()<{ id: string }[]>`
    SELECT id FROM order_lines WHERE order_id = ${id} ORDER BY product_no`;
  return { id, lineIds: lines.map(l => l.id) };
}

async function createReviewing(pur: string, mgr: string) {
  const po = await createPo(pur);
  expect((await api('POST', `/api/orders/${po.id}/advance`, { token: pur })).status).toBe(200);
  expect((await api('POST', `/api/orders/${po.id}/advance`, {
    token: mgr, body: { toStage: 'reviewing' },
  })).status).toBe(200);
  return po;
}

// A sell order's raise of a 0-held line, held open: the line is locked as
// validateSellLines locks it, and the qty moves, uncommitted, until release().
async function holdRaise(lineId: string, soId: string) {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let ready!: () => void;
  const isReady = new Promise<void>(r => { ready = r; });
  const done = getTestDb().begin(async (tx) => {
    await tx`SELECT id FROM order_lines WHERE id = ${lineId} FOR UPDATE`;
    await tx`UPDATE sell_order_lines SET qty = 1 WHERE sell_order_id = ${soId}`;
    ready();
    await gate;
  });
  await isReady;
  return { release, done };
}

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

async function zeroHeld(mgr: string, lineId: string): Promise<string> {
  const soId = await createSellOrderOn(mgr, lineId, PN);
  await getTestDb()`UPDATE sell_order_lines SET qty = 0 WHERE sell_order_id = ${soId}`;
  return soId;
}

describe('a 0-held sell line raised while the PO removes its lot', () => {
  beforeEach(async () => { await resetDb(); });

  it('the removal waits for the raise and then refuses', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await zeroHeld(mgr, lineIds[0]);

    const raise = await holdRaise(lineIds[0], soId);
    const removal = api<{ sellOrderIds?: string[] }>('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { removeLineIds: [lineIds[0]] },
    });
    await pause(300);
    raise.release();
    await raise.done;
    const res = await removal;

    expect(res.status).toBe(409);
    expect(res.body.sellOrderIds).toEqual([soId]);
    const [sol] = await getTestDb()<{ inventory_id: string | null; qty: number }[]>`
      SELECT inventory_id, qty FROM sell_order_lines WHERE sell_order_id = ${soId}`;
    expect(sol).toEqual({ inventory_id: lineIds[0], qty: 1 });
  });

  it('an archive waits for the raise and then names the sell order', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await zeroHeld(mgr, lineIds[0]);

    const raise = await holdRaise(lineIds[0], soId);
    const archive = api<{ code?: string }>('POST', `/api/orders/${id}/archive`, { token: mgr, body: {} });
    await pause(300);
    raise.release();
    await raise.done;
    const res = await archive;

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('committedLines');
    const [line] = await getTestDb()<{ status: string }[]>`SELECT status FROM order_lines WHERE id = ${lineIds[0]}`;
    expect(line.status).toBe('Reviewing');
  });
});

describe('PATCH expectStage', () => {
  beforeEach(async () => { await resetDb(); });

  it('is refused untouched once the PO has left the stage the caller saw', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    expect((await api('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'ready_to_pay', fromStage: 'reviewing' },
    })).status).toBe(200);
    // Back to Reviewing by another hand would be fine; here the page still
    // thinks it is In Transit.
    const res = await api<{ code?: string; lifecycle?: string }>('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { expectStage: 'in_transit', lines: [{ id: lineIds[0], qty: 0 }] },
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'stageMoved', lifecycle: 'ready_to_pay' });
    const [line] = await getTestDb()<{ qty: number }[]>`SELECT qty FROM order_lines WHERE id = ${lineIds[0]}`;
    expect(line.qty).toBe(4);
  });

  it('writes when the PO is where the caller saw it', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const res = await api('PATCH', `/api/orders/${id}`, {
      token: mgr, body: { expectStage: 'reviewing', lines: [{ id: lineIds[0], qty: 0 }] },
    });
    expect(res.status).toBe(200);
    const [line] = await getTestDb()<{ qty: number }[]>`SELECT qty FROM order_lines WHERE id = ${lineIds[0]}`;
    expect(line.qty).toBe(0);
  });
});

describe('a forward move into Reviewing', () => {
  beforeEach(async () => { await resetDb(); });

  it('leaves a Done lot a shipped sell order claims at Done', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createPo(pur);
    expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
    // Hand-set on the inventory page while the PO is In Transit.
    expect((await api('PATCH', `/api/inventory/${lineIds[0]}`, { token: mgr, body: { status: 'Done' } })).status).toBe(200);
    const soId = await createSellOrderOn(mgr, lineIds[0], PN);
    expect((await api('POST', `/api/sell-orders/${soId}/status`, { token: mgr, body: { to: 'Shipped', note: 's' } })).status)
      .toBe(200);

    expect((await api('POST', `/api/orders/${id}/advance`, {
      token: mgr, body: { toStage: 'reviewing', fromStage: 'in_transit' },
    })).status).toBe(200);
    const rows = await getTestDb()<{ id: string; status: string }[]>`
      SELECT id, status FROM order_lines WHERE order_id = ${id} ORDER BY product_no`;
    expect(rows.map(r => r.status)).toEqual(['Done', 'Reviewing']);
  });
});

describe('a purchaser editing a lot through the inventory editor', () => {
  beforeEach(async () => { await resetDb(); });

  const lifecycleOf = async (id: string) =>
    (await getTestDb()<{ lifecycle: string }[]>`SELECT lifecycle FROM orders WHERE id = ${id}`)[0].lifecycle;

  it('sends a submitted PO back to Draft, as the PO editor does', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const res = await api('PATCH', `/api/inventory/${lineIds[0]}`, { token: pur, body: { qty: 3 } });
    expect(res.status).toBe(200);
    expect(await lifecycleOf(id)).toBe('draft');
    const [ev] = await getTestDb()<{ detail: { from: string; lines: { edited: { lineId: string }[] } } }[]>`
      SELECT detail FROM order_events WHERE order_id = ${id} AND kind = 'reverted'`;
    expect(ev.detail.from).toBe('reviewing');
    expect(ev.detail.lines.edited.map(e => e.lineId)).toEqual([lineIds[0]]);
  });

  it('leaves the stage alone for an echoed value', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const res = await api('PATCH', `/api/inventory/${lineIds[0]}`, { token: pur, body: { qty: 4 } });
    expect(res.status).toBe(200);
    expect(await lifecycleOf(id)).toBe('reviewing');
  });

  it('leaves a spec edit to a submitted PO, and its stage, alone', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const res = await api('PATCH', `/api/inventory/${lineIds[0]}`, { token: pur, body: { condition: 'New' } });
    expect(res.status).toBe(200);
    expect(await lifecycleOf(id)).toBe('reviewing');
  });
});

describe('archiving a PO with removeFromSellOrders', () => {
  beforeEach(async () => { await resetDb(); });

  it("drops the removed lot's pack tick with it", async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const { id, lineIds } = await createReviewing(pur, mgr);
    const soId = await createSellOrderOn(mgr, lineIds[0], PN);
    const [sol] = await getTestDb()<{ id: string }[]>`SELECT id FROM sell_order_lines WHERE sell_order_id = ${soId}`;
    expect((await api('PUT', `/api/sell-orders/${soId}/pack/${sol.id}`, {
      token: mgr, body: { counted: 1, packed: true },
    })).status).toBe(200);
    const packRows = async () =>
      (await getTestDb()`SELECT 1 FROM sell_order_packs WHERE sell_order_id = ${soId}`).length;
    expect(await packRows()).toBe(1);

    expect((await api('POST', `/api/orders/${id}/archive`, {
      token: mgr, body: { removeFromSellOrders: true },
    })).status).toBe(200);
    expect(await packRows()).toBe(0);
  });
});
