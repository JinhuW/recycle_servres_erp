import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS, ALEX } from './helpers/auth';

// Realized financials: GET /api/dashboard's revenue/profit/commission (and
// the leaderboard and byCat aggregates) must come from sell_order_lines of
// Done sell orders, priced at sol.unit_price (NOT the PO-side sell_price).
// Date window is the sell order's Done transition (so.updated_at).

async function setupOneDoneSale(opts: { rate: number; unitPrice: number; soldQty: number }) {
  const db = getTestDb();
  await db`DELETE FROM sell_order_lines`;
  await db`DELETE FROM sell_orders`;
  await db`UPDATE orders SET commission_rate = NULL`;

  const line = (await db<{ id: string; unit_cost: string; po_id: string; category: string }[]>`
    SELECT ol.id, ol.unit_cost, ol.order_id AS po_id, ol.category
    FROM order_lines ol
    JOIN orders po ON po.id = ol.order_id
    JOIN users u   ON u.id  = po.user_id
    WHERE u.email = ${MARCUS}
      AND ol.status IN ('Reviewing','Done') AND ol.qty > 0 AND ol.sell_price IS NOT NULL
    LIMIT 1
  `)[0];
  if (!line) throw new Error('no sellable MARCUS line in seed');
  await db`UPDATE orders SET commission_rate = ${opts.rate} WHERE id = ${line.po_id}`;
  const customerId = (await db<{ id: string }[]>`SELECT id FROM customers LIMIT 1`)[0].id;
  await db`
    INSERT INTO sell_orders (id, customer_id, status, created_by, created_at, updated_at)
    VALUES ('SL-TEST-DASH-1', ${customerId}, 'Done',
            (SELECT id FROM users WHERE email = ${MARCUS}), NOW(), NOW())
  `;
  await db`
    INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, qty, unit_price, position)
    VALUES ('SL-TEST-DASH-1', ${line.id}, ${line.category}, 'x', ${opts.soldQty}, ${opts.unitPrice}, 0)
  `;
  return { unitCost: Number(line.unit_cost), category: line.category };
}

describe('GET /api/dashboard — realized financials', () => {
  beforeEach(async () => { await resetDb(); });

  it('purchaser KPIs reflect exactly the realized Done sale (sol.unit_price, not PO sell_price)', async () => {
    const RATE = 0.15;
    const UNIT_PRICE = 777;
    const SOLD_QTY = 2;
    const { unitCost } = await setupOneDoneSale({ rate: RATE, unitPrice: UNIT_PRICE, soldQty: SOLD_QTY });

    const { token } = await loginAs(MARCUS);
    const r = await api<{
      kpis: { count: number; revenue: number; profit: number; commission: number };
    }>('GET', '/api/dashboard?range=30d', { token });
    expect(r.status).toBe(200);

    const expRevenue    = UNIT_PRICE * SOLD_QTY;
    const expProfit     = (UNIT_PRICE - unitCost) * SOLD_QTY;
    const expCommission = expProfit * RATE;

    expect(r.body.kpis.revenue).toBeCloseTo(expRevenue, 2);
    expect(r.body.kpis.profit).toBeCloseTo(expProfit, 2);
    expect(r.body.kpis.commission).toBeCloseTo(expCommission, 2);
    expect(r.body.kpis.count).toBe(1); // one Done sell order in window
  });

  it('leaderboard credits the originating PO purchaser with realized numbers', async () => {
    const RATE = 0.20;
    const UNIT_PRICE = 500;
    const SOLD_QTY = 1;
    const { unitCost } = await setupOneDoneSale({ rate: RATE, unitPrice: UNIT_PRICE, soldQty: SOLD_QTY });

    const { token, user } = await loginAs(MARCUS);
    const r = await api<{
      leaderboard: { id: string; commission: number | null; profit: number | null; revenue: number | null }[];
    }>('GET', '/api/dashboard?range=30d', { token });
    const mine = r.body.leaderboard.find(x => x.id === user.id)!;
    expect(mine).toBeTruthy();
    expect(mine.revenue).toBeCloseTo(UNIT_PRICE * SOLD_QTY, 2);
    expect(mine.profit).toBeCloseTo((UNIT_PRICE - unitCost) * SOLD_QTY, 2);
    expect(mine.commission).toBeCloseTo((UNIT_PRICE - unitCost) * SOLD_QTY * RATE, 2);
  });

  it('no Done sell orders → revenue/profit/commission are all 0', async () => {
    const db = getTestDb();
    await db`DELETE FROM sell_order_lines`;
    await db`DELETE FROM sell_orders`;
    await db`UPDATE orders SET commission_rate = 0.10`; // every PO has a rate

    const { token } = await loginAs(ALEX);
    const r = await api<{ kpis: { revenue: number; profit: number; commission: number } }>(
      'GET', '/api/dashboard?range=90d', { token });
    expect(r.status).toBe(200);
    expect(r.body.kpis.revenue).toBe(0);
    expect(r.body.kpis.profit).toBe(0);
    expect(r.body.kpis.commission).toBe(0);
  });

  it('kpis.prev reflects the equal-length previous window (current excluded)', async () => {
    const { unitCost } = await setupOneDoneSale({ rate: 0.10, unitPrice: 200, soldQty: 1 });
    // Backdate the Done transition into the previous 30d window (45 days ago).
    const db = getTestDb();
    await db`UPDATE sell_orders SET updated_at = NOW() - INTERVAL '45 days' WHERE id = 'SL-TEST-DASH-1'`;

    const { token } = await loginAs(MARCUS);
    const r = await api<{
      kpis: { revenue: number; profit: number; prev: { revenue: number; profit: number } };
    }>('GET', '/api/dashboard?range=30d', { token });

    expect(r.body.kpis.revenue).toBe(0);
    expect(r.body.kpis.profit).toBe(0);
    expect(r.body.kpis.prev.revenue).toBeCloseTo(200, 2);
    expect(r.body.kpis.prev.profit).toBeCloseTo(200 - unitCost, 2);
  });

  it('range windows on the sell-order Done date (updated_at), not PO created_at', async () => {
    await setupOneDoneSale({ rate: 0.1, unitPrice: 100, soldQty: 1 });
    // Backdate the Done transition beyond the 7d window.
    const db = getTestDb();
    await db`UPDATE sell_orders SET updated_at = NOW() - INTERVAL '30 days' WHERE id = 'SL-TEST-DASH-1'`;

    const { token } = await loginAs(MARCUS);
    const inside  = await api<{ kpis: { revenue: number } }>('GET', '/api/dashboard?range=90d', { token });
    const outside = await api<{ kpis: { revenue: number } }>('GET', '/api/dashboard?range=7d',  { token });
    expect(inside.body.kpis.revenue).toBeGreaterThan(0);
    expect(outside.body.kpis.revenue).toBe(0);
  });
});
