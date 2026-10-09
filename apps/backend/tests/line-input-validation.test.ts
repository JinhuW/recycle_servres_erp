import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

// Every door that writes a PO line checks its fields the same way
// (lib/orderInput.ts), and the line editors' full-echo saves land exactly
// what they carry: nothing for an untouched line, a clear for a blank field.

const LINE = {
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
  classification: 'RDIMM', speed: '3200', partNumber: 'M393A4K40DB3-CWE',
  condition: 'Pulled — Tested', qty: 4, unitCost: 78.5,
};

async function createSubmitted(pur: string): Promise<{ id: string; lineId: string }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: [{ ...LINE, chipNumber: 'K4A8G045WC' }],
    },
  });
  expect(created.status).toBe(201);
  expect((await api('POST', `/api/orders/${created.body.id}/advance`, { token: pur })).status).toBe(200);
  const got = await api<{ order: { lines: { id: string }[] } }>('GET', `/api/orders/${created.body.id}`, { token: pur });
  return { id: created.body.id, lineId: got.body.order.lines[0].id };
}

// The desktop drawer's save: every editor-owned field, at its current value.
async function echoOf(id: string, token: string) {
  const got = await api<{ order: { lifecycle: string; lines: Record<string, unknown>[] } }>(
    'GET', `/api/orders/${id}`, { token });
  const l = got.body.order.lines[0];
  const keys = ['category', 'sellPrice', 'qty', 'unitCost', 'brand', 'capacity', 'type', 'generation',
    'classification', 'rank', 'speed', 'interface', 'formFactor', 'description', 'itemType',
    'partNumber', 'serialNumber', 'chipNumber', 'condition', 'health', 'rpm'];
  return {
    lifecycle: got.body.order.lifecycle,
    line: { id: l.id, ...Object.fromEntries(keys.map((k) => [k, l[k] ?? null])) },
  };
}

describe('one line validator', () => {
  beforeEach(async () => { await resetDb(); });

  it('refuses bad numbers and over-long text on create, edit and the inventory editor', async () => {
    const { token } = await loginAs(ALEX);
    const create = (line: Record<string, unknown>) => api<{ error: string }>('POST', '/api/orders', {
      token, body: { category: 'RAM', warehouseId: 'WH-LA1', payment: 'self', lines: [{ ...LINE, ...line }] },
    });
    for (const bad of [{ qty: 0 }, { qty: 1.5 }, { unitCost: -1 }, { sellPrice: -5 }, { health: 101 },
      { rpm: 0 }, { brand: 'x'.repeat(121) }, { brand: 42 }]) {
      const r = await create(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error).toMatch(/^#1: /);
    }
    const missing = await api<{ error: string }>('POST', '/api/orders', {
      token, body: { category: 'RAM', warehouseId: 'WH-LA1', payment: 'self', lines: [{ ...LINE, unitCost: undefined }] },
    });
    expect(missing.status).toBe(400);

    const line = await freeSellableLine(token, 1);
    const [{ order_id: orderId }] = await getTestDb()<{ order_id: string }[]>`
      SELECT order_id FROM order_lines WHERE id = ${line.id}`;
    expect((await api('PATCH', `/api/orders/${orderId}`, { token, body: { lines: [{ id: line.id, rpm: 0 }] } })).status)
      .toBe(400);
    expect((await api('PATCH', `/api/orders/${orderId}`, { token, body: { addLines: [{ ...LINE, unitCost: -1 }] } })).status)
      .toBe(400);
    expect((await api('PATCH', `/api/inventory/${line.id}`, { token, body: { rpm: -3 } })).status).toBe(400);
  });

  it('backs the API with CHECKs on unit cost and goods total', async () => {
    const sql = getTestDb();
    const [l] = await sql<{ id: string; order_id: string }[]>`SELECT id, order_id FROM order_lines LIMIT 1`;
    await expect(sql`UPDATE order_lines SET unit_cost = -1 WHERE id = ${l.id}`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`UPDATE orders SET total_cost = -1 WHERE id = ${l.order_id}`).rejects.toMatchObject({ code: '23514' });
  });
});

describe("the line editors' full-echo save", () => {
  beforeEach(async () => { await resetDb(); });

  it('changes nothing and keeps the stage when nothing was edited', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { id } = await createSubmitted(pur);
    const before = await echoOf(id, pur);
    const r = await api<{ lifecycle: string }>('PATCH', `/api/orders/${id}`, { token: pur, body: { lines: [before.line] } });
    expect(r.status).toBe(200);
    expect(r.body.lifecycle).toBe(before.lifecycle);
    expect((await echoOf(id, pur)).line).toEqual(before.line);
  });

  it('clears a field the user blanked, as a real edit', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { id } = await createSubmitted(pur);
    const before = await echoOf(id, pur);
    const r = await api<{ lifecycle: string }>('PATCH', `/api/orders/${id}`, {
      token: pur, body: { lines: [{ ...before.line, classification: null, chipNumber: '' }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.lifecycle).toBe('draft');
    const after = (await echoOf(id, pur)).line as Record<string, unknown>;
    expect(after.classification).toBeNull();
    expect(after.chipNumber).toBeNull();
    expect(after.brand).toBe('Samsung');
  });
});
