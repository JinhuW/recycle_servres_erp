import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS, PRIYA, ALEX } from './helpers/auth';

// Projected financials are the PURCHASER lens: GET /api/dashboard's
// revenue/profit/commission/count (and the weekly chart + byCat) come from the
// purchaser's OWN purchase orders, but only once the PO's lifecycle = 'done'.
// Profit is the margin "set" on each line — (sell_price - unit_cost) * qty,
// sell_price NULL falling back to unit_cost — the same projection the orders
// list shows. Window keys off the PO's created_at. The manager (realized) lens
// is covered in dashboard-realized.test.ts.

async function userId(email: string): Promise<string> {
  const db = getTestDb();
  return (await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`)[0].id;
}

// Park every seeded order outside the reporting window so a freshly-inserted PO
// is the only thing the projected aggregates can see.
async function clearWindow() {
  await getTestDb()`UPDATE orders SET created_at = NOW() - INTERVAL '400 days'`;
}

async function insertDonePO(
  id: string,
  ownerEmail: string,
  opts: { rate: number | null; lifecycle?: string },
  lines: { unitCost: number; sellPrice: number | null; qty: number; category?: string }[],
) {
  const db = getTestDb();
  const owner = await userId(ownerEmail);
  await db`
    INSERT INTO orders (id, user_id, category, lifecycle, commission_rate, created_at)
    VALUES (${id}, ${owner}, 'HDD', ${opts.lifecycle ?? 'done'}, ${opts.rate}, NOW())
  `;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await db`
      INSERT INTO order_lines (order_id, category, qty, unit_cost, sell_price, position)
      VALUES (${id}, ${l.category ?? 'HDD'}, ${l.qty}, ${l.unitCost}, ${l.sellPrice}, ${i})
    `;
  }
}

describe('GET /api/dashboard — projected financials (purchaser)', () => {
  beforeEach(async () => { await resetDb(); });

  it('purchaser KPIs reflect projected margin from their own Done POs', async () => {
    const RATE = 0.15, UNIT_COST = 100, SELL_PRICE = 250, QTY = 3;
    await clearWindow();
    await insertDonePO('PO-PROJ-1', MARCUS, { rate: RATE }, [{ unitCost: UNIT_COST, sellPrice: SELL_PRICE, qty: QTY }]);

    const { token } = await loginAs(MARCUS);
    const r = await api<{ kpis: { count: number; revenue: number; cost: number; profit: number; commission: number } }>(
      'GET', '/api/dashboard?range=30d', { token });
    expect(r.status).toBe(200);

    const expRevenue = SELL_PRICE * QTY;
    const expCost    = UNIT_COST * QTY;
    const expProfit  = (SELL_PRICE - UNIT_COST) * QTY;
    expect(r.body.kpis.revenue).toBeCloseTo(expRevenue, 2);
    expect(r.body.kpis.cost).toBeCloseTo(expCost, 2);
    expect(r.body.kpis.profit).toBeCloseTo(expProfit, 2);
    expect(r.body.kpis.commission).toBeCloseTo(expProfit * RATE, 2);
    expect(r.body.kpis.count).toBe(1); // one Done PO in window
  });

  it('a purchaser sees only their own POs, not another purchaser\'s', async () => {
    await clearWindow();
    await insertDonePO('PO-PROJ-MINE',  MARCUS, { rate: 0.1 }, [{ unitCost: 10, sellPrice: 30, qty: 1 }]);
    await insertDonePO('PO-PROJ-OTHER', PRIYA,  { rate: 0.1 }, [{ unitCost: 10, sellPrice: 999, qty: 5 }]);

    const { token } = await loginAs(MARCUS);
    const r = await api<{ kpis: { profit: number; count: number } }>('GET', '/api/dashboard?range=30d', { token });
    expect(r.body.kpis.profit).toBeCloseTo((30 - 10) * 1, 2); // only PO-PROJ-MINE
    expect(r.body.kpis.count).toBe(1);
  });

  it('contributor leaderboard ranks purchasers by projected Done-PO profit', async () => {
    await clearWindow();
    // Marcus: 2 * (200-100) = 200 profit; Priya: 1 * (150-100) = 50 profit.
    await insertDonePO('PO-LB-MARCUS', MARCUS, { rate: 0.1 }, [{ unitCost: 100, sellPrice: 200, qty: 2 }]);
    await insertDonePO('PO-LB-PRIYA',  PRIYA,  { rate: 0.2 }, [{ unitCost: 100, sellPrice: 150, qty: 1 }]);

    const marcus = await userId(MARCUS);
    const priya  = await userId(PRIYA);

    // Viewed by a manager so all rows' financials are visible.
    const { token } = await loginAs(ALEX);
    const r = await api<{
      leaderboard: { id: string; profit: number; revenue: number; commission: number }[];
    }>('GET', '/api/dashboard?range=30d', { token });

    const m = r.body.leaderboard.find(x => x.id === marcus)!;
    const p = r.body.leaderboard.find(x => x.id === priya)!;
    expect(m.profit).toBeCloseTo(200, 2);
    expect(m.revenue).toBeCloseTo(400, 2);
    expect(m.commission).toBeCloseTo(200 * 0.1, 2);
    expect(p.profit).toBeCloseTo(50, 2);
    expect(p.commission).toBeCloseTo(50 * 0.2, 2);

    // Ranked by projected profit DESC → Marcus ahead of Priya.
    const idxM = r.body.leaderboard.findIndex(x => x.id === marcus);
    const idxP = r.body.leaderboard.findIndex(x => x.id === priya);
    expect(idxM).toBeLessThan(idxP);
  });

  it('purchaser KPI matches their own leaderboard row (same projected lens)', async () => {
    await clearWindow();
    await insertDonePO('PO-CONSIST', MARCUS, { rate: 0.12 }, [{ unitCost: 100, sellPrice: 175, qty: 2 }]);

    const { token, user } = await loginAs(MARCUS);
    const r = await api<{
      kpis: { revenue: number; profit: number; commission: number };
      leaderboard: { id: string; revenue: number | null; profit: number | null; commission: number | null }[];
    }>('GET', '/api/dashboard?range=30d', { token });
    const mine = r.body.leaderboard.find(x => x.id === user.id)!;
    expect(mine.profit).toBeCloseTo(r.body.kpis.profit, 2);
    expect(mine.revenue).toBeCloseTo(r.body.kpis.revenue, 2);
    expect(mine.commission).toBeCloseTo(r.body.kpis.commission, 2);
  });

  it('a PO contributes nothing until its lifecycle flips to done', async () => {
    await clearWindow();
    await insertDonePO('PO-PROJ-INTRANSIT', MARCUS, { rate: 0.1, lifecycle: 'in_transit' },
      [{ unitCost: 10, sellPrice: 200, qty: 4 }]);

    const { token } = await loginAs(MARCUS);
    const before = await api<{ kpis: { profit: number; count: number } }>('GET', '/api/dashboard?range=30d', { token });
    expect(before.body.kpis.profit).toBe(0);
    expect(before.body.kpis.count).toBe(0);

    await getTestDb()`UPDATE orders SET lifecycle = 'done' WHERE id = 'PO-PROJ-INTRANSIT'`;
    const after = await api<{ kpis: { profit: number; count: number } }>('GET', '/api/dashboard?range=30d', { token });
    expect(after.body.kpis.profit).toBeCloseTo((200 - 10) * 4, 2);
    expect(after.body.kpis.count).toBe(1);
  });

  it('a line with no sell_price contributes zero margin (falls back to unit_cost)', async () => {
    await clearWindow();
    await insertDonePO('PO-PROJ-NULLP', MARCUS, { rate: 0.2 }, [
      { unitCost: 50, sellPrice: null, qty: 2 }, // no margin set
      { unitCost: 50, sellPrice: 80,   qty: 2 }, // +60 margin
    ]);

    const { token } = await loginAs(MARCUS);
    const r = await api<{ kpis: { profit: number; revenue: number } }>('GET', '/api/dashboard?range=30d', { token });
    expect(r.body.kpis.profit).toBeCloseTo((80 - 50) * 2, 2);          // only the priced line
    expect(r.body.kpis.revenue).toBeCloseTo(50 * 2 + 80 * 2, 2);       // null line bills at cost
  });

  it('window keys off the PO created_at', async () => {
    await clearWindow();
    await insertDonePO('PO-PROJ-OLD', MARCUS, { rate: 0.1 }, [{ unitCost: 10, sellPrice: 50, qty: 1 }]);
    await getTestDb()`UPDATE orders SET created_at = NOW() - INTERVAL '30 days' WHERE id = 'PO-PROJ-OLD'`;

    const { token } = await loginAs(MARCUS);
    const inside  = await api<{ kpis: { profit: number } }>('GET', '/api/dashboard?range=90d', { token });
    const outside = await api<{ kpis: { profit: number } }>('GET', '/api/dashboard?range=7d',  { token });
    expect(inside.body.kpis.profit).toBeGreaterThan(0);
    expect(outside.body.kpis.profit).toBe(0);
  });
});
