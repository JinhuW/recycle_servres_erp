import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

// Realized financials: GET /api/me lifetime stats must come from actual sales
// (sell_order_lines of Done sell orders) attributed to the originating PO
// purchaser — not from the PO-side sell_price projection over every line.

describe('GET /api/me — realized lifetime stats', () => {
  beforeEach(async () => { await resetDb(); });

  it('counts revenue/profit/commission only from Done sell orders, using sol.unit_price', async () => {
    const db = getTestDb();
    // Wipe any seeded sell orders so this test is fully deterministic.
    await db`DELETE FROM sell_order_lines`;
    await db`DELETE FROM sell_orders`;
    await db`UPDATE orders SET commission_rate = NULL`;

    // Pick one of MARCUS's sellable PO lines.
    const line = (await db<{ id: string; unit_cost: string; po_id: string }[]>`
      SELECT ol.id, ol.unit_cost, ol.order_id AS po_id
      FROM order_lines ol
      JOIN orders po ON po.id = ol.order_id
      JOIN users u   ON u.id  = po.user_id
      WHERE u.email = ${MARCUS}
        AND ol.status IN ('Reviewing','Done') AND ol.qty > 0 AND ol.sell_price IS NOT NULL
      LIMIT 1
    `)[0];
    expect(line, 'expected at least one sellable Marcus line in seed').toBeTruthy();

    const RATE = 0.10;
    const UNIT_PRICE = 999.00;   // intentionally different from PO sell_price
    const SOLD_QTY = 1;
    const unitCost = Number(line.unit_cost);

    await db`UPDATE orders SET commission_rate = ${RATE} WHERE id = ${line.po_id}`;

    const customerId = (await db<{ id: string }[]>`SELECT id FROM customers LIMIT 1`)[0].id;
    const soId = 'SL-TEST-REALIZED-1';
    await db`
      INSERT INTO sell_orders (id, customer_id, status, created_by, created_at, updated_at)
      VALUES (${soId}, ${customerId}, 'Done',
              (SELECT id FROM users WHERE email = ${MARCUS}), NOW(), NOW())
    `;
    await db`
      INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, qty, unit_price, position)
      VALUES (${soId}, ${line.id}, 'RAM', 'x', ${SOLD_QTY}, ${UNIT_PRICE}, 0)
    `;

    const { token } = await loginAs(MARCUS);
    const r = await api<{ stats: { count: number; profit: number; commission: number; revenue?: number } }>(
      'GET', '/api/me', { token });
    expect(r.status).toBe(200);

    const expectedRevenue    = UNIT_PRICE * SOLD_QTY;
    const expectedProfit     = (UNIT_PRICE - unitCost) * SOLD_QTY;
    const expectedCommission = expectedProfit * RATE;

    expect(r.body.stats.profit).toBeCloseTo(expectedProfit, 2);
    expect(r.body.stats.commission).toBeCloseTo(expectedCommission, 2);
    if (r.body.stats.revenue !== undefined) {
      expect(r.body.stats.revenue).toBeCloseTo(expectedRevenue, 2);
    }
  });

  it('an unsold PO line with sell_price contributes zero to realized stats', async () => {
    const db = getTestDb();
    await db`DELETE FROM sell_order_lines`;
    await db`DELETE FROM sell_orders`;
    await db`UPDATE orders SET commission_rate = 0.10`; // every order has a rate

    const { token } = await loginAs(MARCUS);
    const r = await api<{ stats: { profit: number; commission: number } }>(
      'GET', '/api/me', { token });
    expect(r.status).toBe(200);
    // No Done sell orders exist, so realized commission/profit must both be 0
    // even though every MARCUS line carries a sell_price + a 10% rate.
    expect(r.body.stats.commission).toBe(0);
    expect(r.body.stats.profit).toBe(0);
  });
});
