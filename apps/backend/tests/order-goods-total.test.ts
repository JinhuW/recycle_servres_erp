import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

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

// The PO routes are not the only writers of order_lines. Every other route that
// moves qty or unit_cost has to re-derive the goods total too — not merely so
// the column is fresh, but because the mirror/negotiated verdict is a
// comparison against the line sum. Leave the column behind once and the next
// legitimate PO edit reads the drift as a lot price the business negotiated and
// pins it there for good, with no field left anywhere to put it back.
describe('the goods total follows the lines through every writer', () => {
  beforeEach(async () => { await resetDb(); });

  it('re-derives when the inventory editor changes a unit cost', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 2, unitCost: 50 })] });
    const [lineId] = await lineIds(token, id);

    // The inventory editor is a manager surface; the purchaser raised the PO.
    const mgr = await loginAs(ALEX);
    const r = await api('PATCH', '/api/inventory/' + lineId, { token: mgr.token, body: { unitCost: 80 } });
    expect(r.status).toBe(200);
    expect(await goodsTotal(id)).toBeCloseTo(160, 2);
  });

  it('re-derives when the inventory editor changes a qty', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 2, unitCost: 50 })] });
    const [lineId] = await lineIds(token, id);

    const mgr = await loginAs(ALEX);
    await api('PATCH', '/api/inventory/' + lineId, { token: mgr.token, body: { qty: 5 } });
    expect(await goodsTotal(id)).toBeCloseTo(250, 2);
  });

  it('leaves a negotiated total alone when the inventory editor edits a line', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { totalCost: 90, lines: [line({ qty: 2, unitCost: 50 })] });
    const [lineId] = await lineIds(token, id);

    const mgr = await loginAs(ALEX);
    await api('PATCH', '/api/inventory/' + lineId, { token: mgr.token, body: { unitCost: 80 } });
    expect(await goodsTotal(id)).toBeCloseTo(90, 2);
  });

  // The drift this leaves behind is what later reads as a negotiated price, so
  // the assertion that matters is the one AFTER the next ordinary PO edit.
  it('stays a mirror after an inventory edit, so later PO edits still track', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 2, unitCost: 50 })] });
    const [lineId] = await lineIds(token, id);

    const mgr = await loginAs(ALEX);
    await api('PATCH', '/api/inventory/' + lineId, { token: mgr.token, body: { unitCost: 80 } });
    await api('PATCH', '/api/orders/' + id, { token, body: { addLines: [line({ qty: 1, unitCost: 20 })] } });
    expect(await goodsTotal(id)).toBeCloseTo(180, 2);
  });

  it('re-derives the source PO when a sell order consumes part of a line', async () => {
    const { token } = await loginAs(ALEX);
    const src = await freeSellableLine(token, 2);
    const inv = await api<{ item: { order_id: string } }>('GET', `/api/inventory/${src.id}`, { token });
    const orderId = inv.body.item.order_id;

    const before = await goodsTotal(orderId);
    expect(before).not.toBeNull();

    const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
    const created = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId: customers.body.items[0].id,
        lines: [{ inventoryId: src.id, category: 'RAM', label: 'x', partNumber: 'pn',
                  qty: 1, unitPrice: src.sell_price }],
      },
    });
    expect(created.status).toBe(201);

    const done = await api('POST', `/api/sell-orders/${created.body.id}/status`, {
      token, body: { to: 'Done', note: 'paid' },
    });
    expect(done.status).toBe(200);

    // One unit left the PO, so its goods total drops by that unit's cost.
    expect(await goodsTotal(orderId)).toBeCloseTo((before as number) - src.unit_cost, 2);
  });
});

describe('a stated goods total of zero is not a negotiated price', () => {
  beforeEach(async () => { await resetDb(); });

  // Reading 0 literally pinned the column against real lines, and with no
  // screen able to send a totalCost any more, nothing could put it back.
  it('derives from the lines when the create states zero', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { totalCost: 0, lines: [line({ qty: 2, unitCost: 50 })] });
    expect(await goodsTotal(id)).toBeCloseTo(100, 2);
  });

  it('keeps tracking the lines after a zero-stated create', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { totalCost: 0, lines: [line({ qty: 2, unitCost: 50 })] });
    await api('PATCH', '/api/orders/' + id, { token, body: { addLines: [line({ qty: 1, unitCost: 30 })] } });
    expect(await goodsTotal(id)).toBeCloseTo(130, 2);
  });
});

// 0086 made "unpriced" mean NULL rather than 0, and every revenue query and UI
// predicate now splits on that. 0087 makes the database hold the line, so a
// writer that skips normSellPrice cannot silently reopen the divergence.
describe('the schema refuses a zero sell price', () => {
  beforeEach(async () => { await resetDb(); });

  it('rejects a direct write of 0', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 1, unitCost: 40 })] });
    const [lineId] = await lineIds(token, id);

    await expect(
      getTestDb()`UPDATE order_lines SET sell_price = 0 WHERE id = ${lineId}::uuid`,
    ).rejects.toThrow(/order_lines_sell_price_positive/);
  });

  it('rejects a negative sell price', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 1, unitCost: 40 })] });
    const [lineId] = await lineIds(token, id);

    await expect(
      getTestDb()`UPDATE order_lines SET sell_price = -5 WHERE id = ${lineId}::uuid`,
    ).rejects.toThrow(/order_lines_sell_price_positive/);
  });

  it('still accepts NULL, which is what unpriced means', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 1, unitCost: 40 })] });
    const [lineId] = await lineIds(token, id);

    await getTestDb()`UPDATE order_lines SET sell_price = NULL WHERE id = ${lineId}::uuid`;
    const [row] = await getTestDb()<{ sell_price: number | null }[]>`
      SELECT sell_price FROM order_lines WHERE id = ${lineId}::uuid
    `;
    expect(row.sell_price).toBeNull();
  });

  // The API path collapses 0 to NULL rather than 400ing, so the constraint is a
  // backstop for other writers, not a new rejection surface for clients.
  it('lets the API keep collapsing a 0 to NULL', async () => {
    const { token } = await loginAs(MARCUS);
    const id = await makePo(token, { lines: [line({ qty: 1, unitCost: 40 })] });
    const [lineId] = await lineIds(token, id);

    const r = await api('PATCH', '/api/orders/' + id, {
      token, body: { lines: [{ id: lineId, sellPrice: 0 }] },
    });
    expect(r.status).toBe(200);
    const [row] = await getTestDb()<{ sell_price: number | null }[]>`
      SELECT sell_price FROM order_lines WHERE id = ${lineId}::uuid
    `;
    expect(row.sell_price).toBeNull();
  });
});
