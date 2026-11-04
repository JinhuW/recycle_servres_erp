// Review mode's From sell order button: what the sell orders naming a PO's
// lines charge. Sell orders are a manager's, so a purchaser can neither ask nor
// tell afterwards where a price came from.

import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { getTestDb, resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { createSellOrderOn, firstCustomerId, signOffAll } from './helpers/fixtures';
import { mockFrankfurter } from './helpers/fx';

const PN = 'SO-FILL-PN';
type Prices = { lines: { lineId: string; price: number }[] };

async function createReviewing(pur: string, mgr: string): Promise<{ id: string; lineIds: string[] }> {
  const ram = (capacity: string) => ({
    category: 'RAM', brand: 'Samsung', capacity, type: 'DDR4', classification: 'RDIMM',
    speed: '3200', partNumber: PN, condition: 'Pulled — Tested', qty: 6, unitCost: 40,
  });
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000004', category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: [ram('32GB'), ram('16GB')],
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  expect((await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: 'reviewing' } })).status).toBe(200);
  const got = await api<{ order: { lines: { id: string }[] } }>('GET', `/api/orders/${id}`, { token: mgr });
  return { id, lineIds: got.body.order.lines.map(l => l.id) };
}

describe('GET /api/orders/:id/sell-order-prices', () => {
  let pur: string;
  let mgr: string;
  let id: string;
  let lineIds: string[];

  const prices = async () => {
    const res = await api<Prices>('GET', `/api/orders/${id}/sell-order-prices`, { token: mgr });
    expect(res.status).toBe(200);
    return res.body.lines;
  };

  beforeEach(async () => {
    await resetDb();
    pur = (await loginAs(MARCUS)).token;
    mgr = (await loginAs(ALEX)).token;
    ({ id, lineIds } = await createReviewing(pur, mgr));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is empty when no sell order names the PO', async () => {
    expect(await prices()).toEqual([]);
  });

  it('reads a Draft order and averages several by qty, per line', async () => {
    await createSellOrderOn(mgr, lineIds[0], PN, 1, 90);
    await createSellOrderOn(mgr, lineIds[0], PN, 2, 120.5);
    await createSellOrderOn(mgr, lineIds[1], PN, 1, 75);

    const got = await prices();
    expect(got).toHaveLength(2);
    // (90 + 2 × 120.5) / 3 = 110.333…
    expect(got.find(l => l.lineId === lineIds[0])!.price).toBe(110.33);
    expect(got.find(l => l.lineId === lineIds[1])!.price).toBe(75);
  });

  it('skips Closed and archived orders, and sell lines at qty or price 0', async () => {
    const sql = getTestDb();
    const closed = await createSellOrderOn(mgr, lineIds[0], PN, 1, 500);
    const close = await api('POST', `/api/sell-orders/${closed}/status`, {
      token: mgr, body: { to: 'Closed', note: 'x', closeReasonId: 'customer_cancelled' },
    });
    expect(close.status).toBe(200);

    const archived = await createSellOrderOn(mgr, lineIds[0], PN, 1, 501);
    await sql`UPDATE sell_orders SET archived_at = now() WHERE id = ${archived}`;
    const zeroQty = await createSellOrderOn(mgr, lineIds[0], PN, 1, 502);
    await sql`UPDATE sell_order_lines SET qty = 0 WHERE sell_order_id = ${zeroQty}`;
    const zeroPrice = await createSellOrderOn(mgr, lineIds[0], PN, 1, 503);
    await sql`UPDATE sell_order_lines SET unit_price = 0 WHERE sell_order_id = ${zeroPrice}`;
    expect(await prices()).toEqual([]);

    await createSellOrderOn(mgr, lineIds[0], PN, 1, 88);
    expect(await prices()).toEqual([{ lineId: lineIds[0], price: 88 }]);
  });

  it('counts a Done order', async () => {
    const so = await createSellOrderOn(mgr, lineIds[0], PN, 1, 95);
    expect((await api('POST', `/api/sell-orders/${so}/status`, { token: mgr, body: { to: 'Shipped', note: 'x' } })).status).toBe(200);
    await signOffAll(so);
    expect((await api('POST', `/api/sell-orders/${so}/status`, { token: mgr, body: { to: 'Done', note: 'x' } })).status).toBe(200);
    expect(await prices()).toEqual([{ lineId: lineIds[0], price: 95 }]);
  });

  it('reads a CNY order in dollars', async () => {
    mockFrankfurter(7.2, '2026-06-07');
    const created = await api<{ id: string }>('POST', '/api/sell-orders', {
      token: mgr,
      body: {
        customerId: await firstCustomerId(mgr), currency: 'CNY',
        lines: [{ inventoryId: lineIds[0], category: 'RAM', label: 'x', partNumber: PN, qty: 1, unitPrice: 720 }],
      },
    });
    expect(created.status).toBe(201);
    expect(await prices()).toEqual([{ lineId: lineIds[0], price: 100 }]);
  });

  it('carries no sell order id or customer, even to a manager', async () => {
    const so = await createSellOrderOn(mgr, lineIds[0], PN, 1, 90);
    const res = await api<Prices>('GET', `/api/orders/${id}/sell-order-prices`, { token: mgr });
    expect(Object.keys(res.body.lines[0]).sort()).toEqual(['lineId', 'price']);
    expect(JSON.stringify(res.body)).not.toContain(so);
  });

  it('refuses a purchaser on their own PO and on an unknown one alike', async () => {
    await createSellOrderOn(mgr, lineIds[0], PN, 1, 90);
    const own = await api('GET', `/api/orders/${id}/sell-order-prices`, { token: pur });
    expect(own.status).toBe(403);
    expect(JSON.stringify(own.body)).not.toContain('90');
    expect((await api('GET', '/api/orders/PO-NOPE/sell-order-prices', { token: pur })).status).toBe(403);
    expect((await api('GET', '/api/orders/PO-NOPE/sell-order-prices', { token: mgr })).status).toBe(404);
  });

  it('leaves the purchaser the price and nothing about where it came from', async () => {
    const so = await createSellOrderOn(mgr, lineIds[0], PN, 2, 91.5);
    const [cust] = await getTestDb()<{ name: string; short_name: string | null }[]>`
      SELECT c.name, c.short_name FROM sell_orders s JOIN customers c ON c.id = s.customer_id
      WHERE s.id = ${so}`;

    const [{ lineId, price }] = await prices();
    expect((await api('PATCH', `/api/inventory/${lineId}`, { token: mgr, body: { sellPrice: price } })).status).toBe(200);

    const detail = await api<{ order: { lines: { id: string; sellPrice: number | null }[] } }>(
      'GET', `/api/orders/${id}`, { token: pur });
    expect(detail.status).toBe(200);
    expect(detail.body.order.lines.find(l => l.id === lineId)!.sellPrice).toBe(91.5);

    const line = await api('GET', `/api/inventory/${lineId}`, { token: pur });
    expect(line.status).toBe(200);
    for (const text of [JSON.stringify(detail.body), JSON.stringify(line.body)]) {
      expect(text).not.toContain(so);
      expect(text).not.toContain(cust.name);
      if (cust.short_name) expect(text).not.toContain(cust.short_name);
    }
  });
});
