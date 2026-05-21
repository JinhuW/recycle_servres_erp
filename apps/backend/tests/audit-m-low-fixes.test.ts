import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

describe('M2: GET /api/workspace is manager-only', () => {
  beforeEach(async () => { await resetDb(); });

  it('forbids a purchaser from reading workspace settings', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('GET', '/api/workspace', { token });
    expect(r.status).toBe(403);
  });

  it('still allows a manager', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/workspace', { token });
    expect(r.status).toBe(200);
  });
});

describe('Low: PATCH /api/customers/:id 404s an unknown id', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns 404 instead of a silent 200 for a nonexistent customer', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/customers/00000000-0000-0000-0000-000000000000', {
      token, body: { name: 'X' },
    });
    expect(r.status).toBe(404);
  });
});

describe('Low: dashboard leaderboard masks other purchasers\' email', () => {
  beforeEach(async () => { await resetDb(); });

  it('nulls email for rows that are not the requesting purchaser', async () => {
    const { token, user } = await loginAs(MARCUS);
    const r = await api<{ leaderboard: { id: string; email: string | null }[] }>(
      'GET', '/api/dashboard?range=90d', { token });
    expect(r.status).toBe(200);
    const others = r.body.leaderboard.filter(row => row.id !== user.id);
    expect(others.length).toBeGreaterThan(0);
    for (const row of others) expect(row.email).toBeNull();
  });
});

describe('M4: dashboard recent activity respects the date range', () => {
  beforeEach(async () => { await resetDb(); });

  it('excludes lines from orders older than the selected range', async () => {
    const { token } = await loginAs(MARCUS);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        category: 'RAM',
        lines: [{ category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4',
          classification: 'RDIMM', speed: '3200', partNumber: 'OLD-1',
          condition: 'Pulled — Tested', qty: 1, unitCost: 50 }],
      },
    });
    const oldId = created.body.id;
    const db = getTestDb();
    await db`UPDATE orders SET created_at = NOW() - INTERVAL '30 days' WHERE id = ${oldId}`;

    const r = await api<{ recent: { order_id: string }[] }>(
      'GET', '/api/dashboard?range=7d', { token });
    expect(r.status).toBe(200);
    expect(r.body.recent.some(x => x.order_id === oldId)).toBe(false);
  });
});
