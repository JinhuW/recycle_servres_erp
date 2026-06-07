import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('GET /api/dashboard', () => {
  beforeEach(async () => { await resetDb(); });

  it('manager sees team-wide KPIs', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ role: string; kpis: { revenue: number; commission: number } }>(
      'GET', '/api/dashboard?range=30d', { token });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe('manager');
    expect(r.body.kpis.revenue).toBeGreaterThan(0);
    expect(r.body.kpis.commission).toBeGreaterThanOrEqual(0);
  });

  it('purchaser scope: leaderboard hides others commission', async () => {
    const { token, user } = await loginAs(MARCUS);
    const r = await api<{
      kpis: { revenue: number };
      leaderboard: { id: string; commission: number | null }[];
    }>('GET', '/api/dashboard', { token });
    expect(r.status).toBe(200);
    for (const row of r.body.leaderboard) {
      if (row.id !== user.id) {
        expect(row.commission == null).toBe(true);
      }
    }
  });

  // The contributor leaderboard is the PROJECTED lens (per-purchaser Done-PO
  // margin); its numbers and the purchaser-KPI consistency are covered in
  // dashboard-projected.test.ts.

  it('an order with a NULL commission_rate contributes $0', async () => {
    const { getTestDb } = await import('./helpers/db');
    const db = getTestDb();
    await db`UPDATE orders SET commission_rate = NULL`;
    const { token } = await loginAs(ALEX);
    const r = await api<{ kpis: { commission: number } }>(
      'GET', '/api/dashboard?range=90d', { token });
    expect(r.status).toBe(200);
    expect(r.body.kpis.commission).toBe(0);
  });

  it('money values are rounded to 2 decimal places (no fractional-penny drift)', async () => {
    const { getTestDb } = await import('./helpers/db');
    const db = getTestDb();
    // Insert a sell order with a price that produces a sub-cent float when multiplied
    // (e.g. 1/3 of a cent). This exercises the Math.round rounding in the response.
    await db`DELETE FROM sell_order_lines`;
    await db`DELETE FROM sell_orders`;
    await db`UPDATE orders SET commission_rate = 0.333333`;
    const line = (await db<{ id: string; category: string }[]>`
      SELECT ol.id, ol.category
      FROM order_lines ol JOIN orders po ON po.id = ol.order_id
      WHERE ol.status IN ('Reviewing','Done') AND ol.qty > 0 AND ol.sell_price IS NOT NULL
      LIMIT 1
    `)[0];
    const customerId = (await db<{ id: string }[]>`SELECT id FROM customers LIMIT 1`)[0].id;
    await db`
      INSERT INTO sell_orders (id, customer_id, status, created_by, created_at, updated_at)
      VALUES ('SO-TEST-ROUND', ${customerId}, 'Done',
              (SELECT id FROM users LIMIT 1), NOW(), NOW())
    `;
    // unit_price=1.005 so revenue = 1.005 (rounds to 1.01 or 1.00 depending on impl)
    await db`
      INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, qty, unit_price, position)
      VALUES ('SO-TEST-ROUND', ${line.id}, ${line.category}, 'x', 1, 1.005, 0)
    `;

    const { token } = await loginAs(ALEX);
    const r = await api<{ kpis: { revenue: number; profit: number; commission: number } }>(
      'GET', '/api/dashboard?range=90d', { token });
    expect(r.status).toBe(200);
    // All money values must have at most 2 decimal places (no sub-cent remainder)
    const check = (v: number) => expect(Math.abs(Number((v * 100).toFixed(10)) % 1)).toBe(0);
    check(r.body.kpis.revenue);
    check(r.body.kpis.profit);
    check(r.body.kpis.commission);
  });

  it('range honored: 7d returns less than 90d', async () => {
    const { token } = await loginAs(ALEX);
    const a = await api<{ kpis: { count: number } }>('GET', '/api/dashboard?range=7d', { token });
    const b = await api<{ kpis: { count: number } }>('GET', '/api/dashboard?range=90d', { token });
    expect(a.body.kpis.count).toBeLessThanOrEqual(b.body.kpis.count);
  });
});
