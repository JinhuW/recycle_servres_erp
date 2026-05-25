import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

describe('GET /api/me — lifetime commission uses per-order rate', () => {
  beforeEach(async () => { await resetDb(); });

  it('is $0 when every order rate is NULL', async () => {
    const db = getTestDb();
    await db`UPDATE orders SET commission_rate = NULL`;
    const { token } = await loginAs(MARCUS);
    const r = await api<{ stats: { commission: number } }>('GET', '/api/me', { token });
    expect(r.status).toBe(200);
    expect(r.body.stats.commission).toBe(0);
  });

  it('equals realized profit x the originating PO rate', async () => {
    // Set up a single Done sale of a MARCUS-owned PO line so realized profit
    // is deterministic and nonzero (the seed's one Done sell order may not
    // contain a MARCUS line).
    const db = getTestDb();
    await db`DELETE FROM sell_order_lines`;
    await db`DELETE FROM sell_orders`;
    await db`UPDATE orders SET commission_rate = 0.10`;

    const line = (await db<{ id: string; po_id: string }[]>`
      SELECT ol.id, ol.order_id AS po_id
      FROM order_lines ol
      JOIN orders po ON po.id = ol.order_id
      JOIN users u   ON u.id  = po.user_id
      WHERE u.email = ${MARCUS}
        AND ol.status IN ('Reviewing','Done') AND ol.qty > 0 AND ol.sell_price IS NOT NULL
      LIMIT 1
    `)[0];
    expect(line, 'expected at least one sellable Marcus line in seed').toBeTruthy();

    const customerId = (await db<{ id: string }[]>`SELECT id FROM customers LIMIT 1`)[0].id;
    await db`
      INSERT INTO sell_orders (id, customer_id, status, created_by, created_at, updated_at)
      VALUES ('SO-TEST-COMM-1', ${customerId}, 'Done',
              (SELECT id FROM users WHERE email = ${MARCUS}), NOW(), NOW())
    `;
    await db`
      INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, qty, unit_price, position)
      VALUES ('SO-TEST-COMM-1', ${line.id}, 'RAM', 'x', 1, 500.00, 0)
    `;

    const { token } = await loginAs(MARCUS);
    const r = await api<{ stats: { profit: number; commission: number } }>(
      'GET', '/api/me', { token });
    expect(r.status).toBe(200);
    expect(r.body.stats.profit).toBeGreaterThan(0);
    // Every order has rate 0.10, so realized commission = realized profit * 0.10.
    expect(r.body.stats.commission).toBeCloseTo(r.body.stats.profit * 0.10, 2);
  });
});
