import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, MARCUS, ALEX } from './helpers/auth';
import { REPORTING_TZ, todayIn, addDays, startOfYear } from '@recycle-erp/shared';

// The reporting window is two calendar dates in the business time zone
// (America/Denver). `from`/`to` are the interface; `range` presets resolve to
// the same two dates. Every window below is checked through the purchaser's
// projected count (own Ready-to-Pay/Done POs by created_at), the cheapest
// figure that a window can move.

const TZ = REPORTING_TZ;

async function userId(email: string): Promise<string> {
  return (await getTestDb()<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`)[0].id;
}

// Park the seed outside any window the tests look at.
async function clearWindow() {
  await getTestDb()`UPDATE orders SET created_at = NOW() - INTERVAL '900 days'`;
}

// A Done PO created one hour into the given business-zone calendar day.
async function insertPOOn(
  id: string, ownerEmail: string, day: string, unitCost = 100, sellPrice = 150, lifecycle = 'done',
) {
  const db = getTestDb();
  const owner = await userId(ownerEmail);
  await db`
    INSERT INTO orders (id, user_id, category, lifecycle, commission_rate, other_fees, created_at)
    VALUES (${id}, ${owner}, 'HDD', ${lifecycle}, 0.1, 0,
            (${day}::date::timestamp AT TIME ZONE ${TZ}) + INTERVAL '1 hour')
  `;
  await db`
    INSERT INTO order_lines (order_id, category, qty, unit_cost, sell_price, position)
    VALUES (${id}, 'HDD', 1, ${unitCost}, ${sellPrice}, 0)
  `;
}

type Body = {
  kpis: { count: number; revenue: number; profit: number };
  window: { from: string; to: string; prevFrom: string; prevTo: string; bucket: string; tz: string };
  bounds: { first: string | null };
  series: { start: string; revenue: number; cost: number; profit: number }[];
  leaderboard: { cost: number | null }[];
  contrib: { cost: { total: number } };
};

describe('GET /api/dashboard — reporting window', () => {
  beforeEach(async () => { await resetDb(); });

  it('from/to scope by business-zone calendar day, inclusive', async () => {
    await clearWindow();
    await insertPOOn('PO-WIN-IN',   MARCUS, '2026-03-10');
    await insertPOOn('PO-WIN-EDGE', MARCUS, '2026-03-20');
    await insertPOOn('PO-WIN-OUT',  MARCUS, '2026-03-21');
    const { token } = await loginAs(MARCUS);
    const r = await api<Body>('GET', '/api/dashboard?from=2026-03-10&to=2026-03-20', { token });
    expect(r.status).toBe(200);
    expect(r.body.kpis.count).toBe(2);
    expect(r.body.window).toMatchObject({
      from: '2026-03-10', to: '2026-03-20', prevFrom: '2026-02-27', prevTo: '2026-03-09', tz: TZ,
    });
  });

  it('rejects a malformed, inverted, or half-given window and an unknown bucket', async () => {
    const { token } = await loginAs(MARCUS);
    for (const qs of [
      'from=2026-02-30&to=2026-03-01',
      'from=2026-03-10&to=2026-03-09',
      'from=2026-03-10',
      'from=2026-03-10&to=2026-03-20&bucket=hour',
      'from=2020-01-01&to=2026-03-20',
    ]) {
      const r = await api<{ error: string }>('GET', `/api/dashboard?${qs}`, { token });
      expect(r.status, qs).toBe(400);
      expect(r.body.error).toBe('invalid_range');
    }
  });

  it('range=ytd starts on 1 January, not 365 days ago', async () => {
    await clearWindow();
    const today = todayIn(TZ);
    const jan1 = startOfYear(today);
    await insertPOOn('PO-YTD-DEC', MARCUS, addDays(jan1, -1));
    await insertPOOn('PO-YTD-JAN', MARCUS, jan1);
    const { token } = await loginAs(MARCUS);
    const r = await api<Body>('GET', '/api/dashboard?range=ytd', { token });
    expect(r.body.kpis.count).toBe(1);
    expect(r.body.window.from).toBe(jan1);
    expect(r.body.window.to).toBe(today);
  });

  it('a range preset is the same window as its dates', async () => {
    const { token } = await loginAs(MARCUS);
    const today = todayIn(TZ);
    const a = await api<Body>('GET', '/api/dashboard?range=30d', { token });
    const b = await api<Body>('GET', `/api/dashboard?from=${addDays(today, -29)}&to=${today}`, { token });
    expect(a.body.window).toEqual(b.body.window);
    expect(a.body.kpis).toEqual(b.body.kpis);
    // The default, and an unknown preset, are still 30 days.
    const c = await api<Body>('GET', '/api/dashboard?range=fortnight', { token });
    expect(c.body.window).toEqual(a.body.window);
  });

  it('buckets follow the span and can be overridden; the series covers the window', async () => {
    const { token } = await loginAs(ALEX);
    const week = await api<Body>('GET', '/api/dashboard?from=2026-03-10&to=2026-03-16', { token });
    expect(week.body.window.bucket).toBe('day');
    expect(week.body.series.map(s => s.start)).toEqual([
      '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15', '2026-03-16',
    ]);
    const year = await api<Body>('GET', '/api/dashboard?from=2026-01-15&to=2026-09-17', { token });
    expect(year.body.window.bucket).toBe('month');
    expect(year.body.series[0].start).toBe('2026-01-01');
    expect(year.body.series.at(-1)!.start).toBe('2026-09-01');
    expect(year.body.series).toHaveLength(9);
    // Tue 10 – Sun 15 March sits inside one ISO week, which starts on Monday the 9th.
    const forced = await api<Body>('GET', '/api/dashboard?from=2026-03-10&to=2026-03-15&bucket=week', { token });
    expect(forced.body.window.bucket).toBe('week');
    expect(forced.body.series).toHaveLength(1);
    expect(forced.body.series[0].start).toBe('2026-03-09');
  });

  it('a partial first bucket is clipped: the series sums to the tiles and the Cost card', async () => {
    // Three POs in the same March week; the window starts mid-week and includes
    // only the last two, so an unclipped week bucket would count all three.
    // The Reviewing one is spend but not yet a projection.
    await clearWindow();
    await insertPOOn('PO-CLIP-A', MARCUS, '2026-03-10', 100, 150);
    await insertPOOn('PO-CLIP-B', MARCUS, '2026-03-12', 100, 180);
    await insertPOOn('PO-CLIP-C', MARCUS, '2026-03-13', 60, 90, 'reviewing');
    const { token } = await loginAs(MARCUS);
    const r = await api<Body>('GET', '/api/dashboard?from=2026-03-11&to=2026-03-15&bucket=week', { token });
    expect(r.body.kpis.count).toBe(1);
    const sum = (k: 'revenue' | 'profit' | 'cost') => r.body.series.reduce((s, b) => s + b[k], 0);
    expect(sum('revenue')).toBeCloseTo(r.body.kpis.revenue, 2);
    expect(sum('profit')).toBeCloseTo(r.body.kpis.profit, 2);
    expect(sum('revenue')).toBeCloseTo(180, 2);
    expect(sum('cost')).toBeCloseTo(r.body.contrib.cost.total, 2);
    expect(sum('cost')).toBeCloseTo(160, 2);
  });

  it('bounds.first is the earliest order day in the business zone', async () => {
    const db = getTestDb();
    await db`DELETE FROM sell_order_lines`;
    await db`DELETE FROM sell_orders`;
    // 05:00 UTC on 27 Feb is still 26 Feb in Denver.
    await db`UPDATE orders SET created_at = '2026-02-27T05:00:00Z'`;
    const { token } = await loginAs(ALEX);
    const r = await api<Body>('GET', '/api/dashboard', { token });
    expect(r.body.bounds.first).toBe('2026-02-26');
  });
});
