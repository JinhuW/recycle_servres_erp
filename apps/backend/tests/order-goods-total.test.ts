import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

// orders.total_cost is the PO's goods total. It is USUALLY a denormalization of
// the lines — kept as a column so the list's keyset sort, the draft picker and
// the spreadsheet read one number instead of aggregating — but it can also be a
// negotiated lot price that no line arithmetic produces.
//
// No screen can enter one any more, so nothing keeping it in step with the
// lines meant every edit left it stale: the cost tape itemised categories that
// summed to one figure under a goods total that still held the pre-edit one.
// Deriving it fixes that; the negotiated figures are what must survive it.

const goodsTotal = async (id: string): Promise<number | null> => {
  const [row] = await getTestDb()<{ total_cost: number | null }[]>`
    SELECT total_cost::float AS total_cost FROM orders WHERE id = ${id}
  `;
  return row.total_cost;
};

const line = (over: Record<string, unknown> = {}) => ({
  category: 'RAM', brand: 'Samsung', partNumber: 'GT-' + Math.random().toString(36).slice(2, 8),
  condition: 'Pulled — Tested', qty: 1, unitCost: 100, ...over,
});

const makePo = async (token: string, body: Record<string, unknown>) => {
  const r = await api<{ id: string }>('POST', '/api/orders', { token, body });
  expect(r.status).toBe(201);
  return r.body.id;
};

const lineIds = async (token: string, id: string) =>
  (await api<{ order: { lines: { id: string }[] } }>('GET', '/api/orders/' + id, { token }))
    .body.order.lines.map(l => l.id);

describe('orders.total_cost follows the lines', () => {
  beforeEach(async () => { await resetDb(); });

  it('is derived on create when the request states none', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 2, unitCost: 50 }), line({ qty: 1, unitCost: 30 })] });
    expect(await goodsTotal(id)).toBeCloseTo(130, 2);
  });

  it('re-derives when a line is added', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 2, unitCost: 50 })] });
    await api('PATCH', '/api/orders/' + id, { token, body: { addLines: [line({ qty: 1, unitCost: 30 })] } });
    expect(await goodsTotal(id)).toBeCloseTo(130, 2);
  });

  it('re-derives when a unit cost is edited', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 2, unitCost: 50 })] });
    const [lineId] = await lineIds(token, id);
    await api('PATCH', '/api/orders/' + id, { token, body: { lines: [{ id: lineId, unitCost: 75 }] } });
    expect(await goodsTotal(id)).toBeCloseTo(150, 2);
  });

  it('re-derives when a line is removed', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 2, unitCost: 50 }), line({ qty: 1, unitCost: 30 })] });
    const ids = await lineIds(token, id);
    await api('PATCH', '/api/orders/' + id, { token, body: { removeLineIds: [ids[1]] } });
    expect(await goodsTotal(id)).toBeCloseTo(100, 2);
  });

  it('leaves it alone when the request changes no lines', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 2, unitCost: 50 })] });
    await api('PATCH', '/api/orders/' + id, { token, body: { notes: 'just a note' } });
    expect(await goodsTotal(id)).toBeCloseTo(100, 2);
  });
});

describe('a negotiated goods total survives the lines under it', () => {
  beforeEach(async () => { await resetDb(); });

  // The purchaser paid a lot price the line costs don't add up to. Recomputing
  // it would quietly rewrite what the business actually paid, and with no field
  // left anywhere to enter one, nothing could put the figure back.
  it('is kept when the create states one that differs from the line sum', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { totalCost: 90, lines: [line({ qty: 2, unitCost: 50 })] });
    expect(await goodsTotal(id)).toBeCloseTo(90, 2);
  });

  it('is kept across an edit to the lines', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { totalCost: 90, lines: [line({ qty: 2, unitCost: 50 })] });
    await api('PATCH', '/api/orders/' + id, { token, body: { addLines: [line({ qty: 1, unitCost: 30 })] } });
    expect(await goodsTotal(id)).toBeCloseTo(90, 2);
  });

  it('yields to a request that states a new one outright', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { totalCost: 90, lines: [line({ qty: 2, unitCost: 50 })] });
    await api('PATCH', '/api/orders/' + id, {
      token,
      body: { totalCost: 140, addLines: [line({ qty: 1, unitCost: 30 })] },
    });
    expect(await goodsTotal(id)).toBeCloseTo(140, 2);
  });

  // The mirror/override verdict is read at the top of the transaction, so a
  // total that HAPPENED to equal the old line sum is treated as a mirror and
  // moves with them. That is the intended reading: it is what every write since
  // the goods field was removed produces.
  it('a total that matched the old line sum tracks the new one', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { totalCost: 100, lines: [line({ qty: 2, unitCost: 50 })] });
    await api('PATCH', '/api/orders/' + id, { token, body: { addLines: [line({ qty: 1, unitCost: 30 })] } });
    expect(await goodsTotal(id)).toBeCloseTo(130, 2);
  });
});
