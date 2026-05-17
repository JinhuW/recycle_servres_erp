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

  it('equals lifetime profit x a uniform per-order rate', async () => {
    const db = getTestDb();
    await db`UPDATE orders SET commission_rate = 0.10`;
    const { token } = await loginAs(MARCUS);
    const r = await api<{ stats: { profit: number; commission: number } }>(
      'GET', '/api/me', { token });
    expect(r.status).toBe(200);
    expect(r.body.stats.profit).toBeGreaterThan(0);
    // Every order now has rate 0.10, so lifetime commission = profit * 0.10.
    expect(r.body.stats.commission).toBeCloseTo(r.body.stats.profit * 0.10, 2);
  });
});
