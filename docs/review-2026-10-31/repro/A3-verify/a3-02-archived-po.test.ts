// Review 2026-10-31, lane A3 verification, claim A3-02.
// Asserts the claimed inconsistency: an archived Done PO is out of spend but
// still in the purchaser projection, leaderboard and contribution cards.
// Run: cd docs/review-2026-10-31/repro/A3-verify &&
//   TEST_DATABASE_URL=postgres://postgres:review@127.0.0.1:55703/postgres \
//   ../../../../apps/backend/node_modules/.bin/vitest run --config vitest.config.ts a3-02
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from '../../../../apps/backend/tests/helpers/db';
import { api } from '../../../../apps/backend/tests/helpers/app';
import { loginAs, MARCUS, ALEX } from '../../../../apps/backend/tests/helpers/auth';

type M = { total: number };
type Body = {
  kpis: { revenue: number; profit: number; commission: number };
  leaderboard: { email?: string; name: string; cost?: number; commission?: number; id: string }[];
  contrib: { cost: M; revenue: M; profit: M };
};

describe('A3-02 archived PO in dashboard', () => {
  beforeEach(async () => {
    await resetDb();
    const db = getTestDb();
    await db`DELETE FROM sell_order_lines`;
    await db`DELETE FROM sell_orders`;
    await db`UPDATE orders SET created_at = NOW() - INTERVAL '900 days'`;
    const [{ id: owner }] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${MARCUS}`;
    await db`INSERT INTO orders (id, user_id, category, lifecycle, commission_rate, other_fees, total_cost, created_at, archived_at)
             VALUES ('PO-A3V-ARCH', ${owner}, 'RAM', 'done', 0.1, 0, 100, NOW(), NOW())`;
    await db`INSERT INTO order_lines (order_id, category, qty, unit_cost, sell_price, position)
             VALUES ('PO-A3V-ARCH', 'RAM', 1, 100, 200, 0)`;
  });

  it('purchaser: spend excludes it, projection keeps it', async () => {
    const { token, user } = await loginAs(MARCUS);
    const r = await api<Body>('GET', '/api/dashboard?range=7d', { token });
    expect(r.status).toBe(200);
    const me = r.body.leaderboard.find(x => x.id === user.id)!;
    console.log('A3-02 purchaser', JSON.stringify({ kpis: r.body.kpis, contribCost: r.body.contrib.cost.total,
      contribRev: r.body.contrib.revenue.total, contribProfit: r.body.contrib.profit.total, me }));
    expect(r.body.contrib.cost.total).toBe(0);
    expect(r.body.kpis.profit).toBeCloseTo(100, 2);
    expect(r.body.kpis.commission).toBeCloseTo(10, 2);
    expect(r.body.contrib.profit.total).toBeCloseTo(100, 2);
    expect(me.cost).toBeCloseTo(100, 2);
    expect(me.commission).toBeCloseTo(10, 2);
  });

  it('manager leaderboard keeps it too', async () => {
    const { token } = await loginAs(ALEX);
    const [{ id: marcusId }] = await getTestDb()<{ id: string }[]>`SELECT id FROM users WHERE email = ${MARCUS}`;
    const r = await api<Body>('GET', '/api/dashboard?range=7d', { token });
    const row = r.body.leaderboard.find(x => x.id === marcusId)!;
    console.log('A3-02 manager', JSON.stringify({ contribCost: r.body.contrib.cost.total, row }));
    expect(r.body.contrib.cost.total).toBe(0);
    expect(row.cost).toBeCloseTo(100, 2);
  });
});
