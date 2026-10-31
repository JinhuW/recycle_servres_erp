// Review 2026-10-31, lane A3. These cases ASSERT THE DEFECTIVE BEHAVIOUR so
// they pass on 62f53dec and start failing once the finding is fixed.
// Replay: cp to apps/backend/tests/review-a3-repro.test.ts, set
// TEST_DATABASE_URL to a disposable Postgres 18, then
//   cd apps/backend && VITEST_MAX_FORKS=1 npx vitest run tests/review-a3-repro.test.ts
// and delete the copy afterwards.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { mockFrankfurter } from './helpers/fx';

async function userId(email: string): Promise<string> {
  return (await getTestDb()<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`)[0].id;
}

describe('A3 repro', () => {
  beforeEach(async () => {
    await resetDb();
    mockFrankfurter(7.2, '2026-10-30');
  });
  afterEach(() => vi.unstubAllGlobals());

  // A3-01: the manual override has no upper bound, while accounting_entries
  // caps fx_rate at 100. A typo (7100 for 7.10) is stored, becomes the
  // "latest" rate, and every USD entry booked without an explicit rate 500s.
  it('A3-01 an unbounded manual CNY rate breaks USD accounting entries', async () => {
    const { token } = await loginAs(ALEX);
    const set = await api('POST', '/api/workspace/fx-rates', { token, body: { quote: 'CNY', rate: 7100 } });
    expect(set.status).toBe(201);
    const entry = await api('POST', '/api/accounting/entries', {
      token,
      body: {
        direction: 'out', kind: 'other', amount: 10, currency: 'USD', method: 'bank',
        occurredOn: '2026-10-30', managerId: await userId(ALEX),
      },
    });
    expect(entry.status).toBe(500);
  });

  // A3-02: an archived PO is out of spend (dashboard.ts:69-72) but still in
  // the purchaser projection and the leaderboard (dashboard.ts:59-62, 274, 285)
  // and in contributions' revenue/profit (contributions.ts:69-70).
  it('A3-02 an archived Done PO still earns commission on the dashboard', async () => {
    const db = getTestDb();
    await db`DELETE FROM sell_order_lines`;
    await db`DELETE FROM sell_orders`;
    await db`UPDATE orders SET created_at = NOW() - INTERVAL '900 days'`;
    const marcus = await userId(MARCUS);
    await db`
      INSERT INTO orders (id, user_id, category, lifecycle, commission_rate, other_fees, total_cost, created_at, archived_at)
      VALUES ('PO-A3-ARCH', ${marcus}, 'RAM', 'done', 0.1, 0, 100, NOW(), NOW())`;
    await db`
      INSERT INTO order_lines (order_id, category, qty, unit_cost, sell_price, position)
      VALUES ('PO-A3-ARCH', 'RAM', 1, 100, 200, 0)`;

    const { token } = await loginAs(MARCUS);
    const r = await api<{
      kpis: { commission: number; profit: number; cost: number };
      leaderboard: { id: string; commission?: number; cost?: number }[];
      contrib: { cost: { total: number }; profit: { total: number } };
    }>('GET', '/api/dashboard?range=7d', { token });
    expect(r.status).toBe(200);
    // Spend correctly excludes it…
    expect(r.body.contrib.cost.total).toBe(0);
    // …but the projection, the leaderboard and the profit card still count it.
    expect(r.body.kpis.commission).toBeCloseTo(10, 2);
    expect(r.body.kpis.profit).toBeCloseTo(100, 2);
    const me = r.body.leaderboard.find(x => x.id === marcus)!;
    expect(me.commission).toBeCloseTo(10, 2);
    expect(me.cost).toBeCloseTo(100, 2);
    expect(r.body.contrib.profit.total).toBeCloseTo(100, 2);
  });
});
