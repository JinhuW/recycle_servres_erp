import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { createSellOrderOn } from './helpers/fixtures';

// Writers that touch a PO and its lines take the orders row first, then the
// lines (services/orderLocks.ts). One that went line-first — the inventory
// editor, a sell order's Done, a transfer's FK check against a FOR UPDATE
// order — deadlocked against PO PATCH, and Postgres aborted one side with
// 40P01, which surfaced as a 500. Each pair here runs side by side a few
// times; neither side may 500, and the derived total must match its lines.

const ROUNDS = 4;

async function lineOrder(lineId: string): Promise<string> {
  const [r] = await getTestDb()<{ order_id: string }[]>`SELECT order_id FROM order_lines WHERE id = ${lineId}`;
  return r.order_id;
}

async function totalMatchesLines(orderId: string): Promise<boolean> {
  const [r] = await getTestDb()<{ total: number | null; sum: number }[]>`
    SELECT o.total_cost::float AS total,
           COALESCE(SUM(COALESCE(l.qty_purchased, l.qty) * l.unit_cost), 0)::float AS sum
    FROM orders o LEFT JOIN order_lines l ON l.order_id = o.id
    WHERE o.id = ${orderId} GROUP BY o.id`;
  return r.total === null || Math.abs(r.total - r.sum) < 0.01;
}

async function otherWarehouse(token: string, lineId: string): Promise<string> {
  const [r] = await getTestDb()<{ wh: string | null }[]>`
    SELECT COALESCE(l.warehouse_id, o.warehouse_id) AS wh
    FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.id = ${lineId}`;
  const whs = await api<{ items: { id: string }[] }>('GET', '/api/warehouses', { token });
  return whs.body.items.find((w) => w.id !== r.wh)!.id;
}

const poPatchCost = (token: string, orderId: string, lineId: string, unitCost: number) =>
  api('PATCH', `/api/orders/${orderId}`, { token, body: { lines: [{ id: lineId, unitCost }] } });

describe('PO writers share one lock order', () => {
  beforeEach(async () => { await resetDb(); });

  it('inventory edit and PO PATCH on the same line', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 2);
    const orderId = await lineOrder(line.id);
    for (let i = 0; i < ROUNDS; i++) {
      const [a, b] = await Promise.all([
        api('PATCH', `/api/inventory/${line.id}`, { token, body: { unitCost: line.unit_cost + i + 1 } }),
        poPatchCost(token, orderId, line.id, line.unit_cost + i + 2),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
    }
    expect(await totalMatchesLines(orderId)).toBe(true);
  });

  it('partial transfer and PO PATCH on the same order', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, ROUNDS + 2);
    const orderId = await lineOrder(line.id);
    const to = await otherWarehouse(token, line.id);
    for (let i = 0; i < ROUNDS; i++) {
      const [a, b] = await Promise.all([
        api('POST', '/api/inventory/transfer', {
          token, body: { toWarehouseId: to, lines: [{ id: line.id, qty: 1 }] },
        }),
        poPatchCost(token, orderId, line.id, line.unit_cost + i + 1),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    }
    expect(await totalMatchesLines(orderId)).toBe(true);
  });

  it("a sell order's Done and PO PATCH on its source PO", async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, ROUNDS + 1);
    const orderId = await lineOrder(line.id);
    for (let i = 0; i < ROUNDS; i++) {
      const so = await createSellOrderOn(token, line.id, `PN-LOCK-${i}`, 1);
      expect((await api('POST', `/api/sell-orders/${so}/status`, { token, body: { to: 'Shipped', note: 's' } })).status)
        .toBe(200);
      const [a, b] = await Promise.all([
        api('POST', `/api/sell-orders/${so}/status`, { token, body: { to: 'Done', note: 'paid' } }),
        poPatchCost(token, orderId, line.id, line.unit_cost + i + 1),
      ]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    }
    expect(await totalMatchesLines(orderId)).toBe(true);
  });
});
