import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

type Item = { id: string; samples: number; lastPriceAt: string | null };
type Body = { total: number; items: Item[]; targetMargin: number };

describe('GET /api/market — pagination, sort & stale filter', () => {
  beforeEach(async () => { await resetDb(); });

  it('reports total and pages with offset', async () => {
    const { token } = await loginAs(ALEX);

    const first = await api<Body>('GET', '/api/market', { token });
    expect(first.status).toBe(200);
    expect(typeof first.body.total).toBe('number');
    // Seed holds fewer than one page (100), so the first page is the whole set.
    expect(first.body.total).toBe(first.body.items.length);

    // Offsetting past the end keeps total stable and returns no rows.
    const past = await api<Body>('GET', `/api/market?offset=${first.body.total}`, { token });
    expect(past.body.total).toBe(first.body.total);
    expect(past.body.items.length).toBe(0);

    // A mid-set offset drops exactly that many leading rows, no overlap.
    const skip = Math.min(5, first.body.total);
    const tail = await api<Body>('GET', `/api/market?offset=${skip}`, { token });
    expect(tail.body.items.length).toBe(first.body.total - skip);
    expect(tail.body.items[0]?.id).toBe(first.body.items[skip]?.id);
  });

  it('sorts server-side by samples', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<Body>('GET', '/api/market?sort=samples', { token });
    expect(r.status).toBe(200);
    const samples = r.body.items.map(i => i.samples);
    const sorted = [...samples].sort((a, b) => b - a);
    expect(samples).toEqual(sorted);
  });

  it('staleOnly returns a subset of only-stale rows', async () => {
    const { token } = await loginAs(ALEX);
    const all = await api<Body>('GET', '/api/market', { token });
    const stale = await api<Body>('GET', '/api/market?staleOnly=1', { token });
    expect(stale.status).toBe(200);
    expect(stale.body.total).toBeLessThanOrEqual(all.body.total);
    const sixDaysAgo = Date.now() - 6 * 86_400_000;
    for (const it of stale.body.items) {
      const stale6 = it.lastPriceAt == null || +new Date(it.lastPriceAt) < sixDaysAgo;
      expect(stale6).toBe(true);
    }
  });
});
