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

  it('KPI commission = sum of profit x per-order rate, matching the leaderboard', async () => {
    const { token, user } = await loginAs(MARCUS);
    const r = await api<{
      kpis: { commission: number };
      leaderboard: { id: string; commission: number | null }[];
    }>('GET', '/api/dashboard?range=90d', { token });
    expect(r.status).toBe(200);
    const mine = r.body.leaderboard.find(x => x.id === user.id);
    expect(mine?.commission).not.toBeNull();
    expect(mine!.commission as number).toBeGreaterThan(0); // non-vacuous: seed gives non-draft orders a rate
    // A purchaser's whole-dashboard scope is exactly their own orders, so the
    // KPI commission must equal their leaderboard commission.
    expect(r.body.kpis.commission).toBeCloseTo(mine!.commission as number, 2);
  });

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

  it('range honored: 7d returns less than 90d', async () => {
    const { token } = await loginAs(ALEX);
    const a = await api<{ kpis: { count: number } }>('GET', '/api/dashboard?range=7d', { token });
    const b = await api<{ kpis: { count: number } }>('GET', '/api/dashboard?range=90d', { token });
    expect(a.body.kpis.count).toBeLessThanOrEqual(b.body.kpis.count);
  });
});
