import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// Mock Frankfurter the same way fx-fetcher.test.ts does — vi.stubGlobal on
// fetch. Avoids undici MockAgent (not installed) and matches existing repo
// pattern (ai.test.ts, scan.test.ts).
function mockFrankfurter(rate: number, date = '2026-05-26') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ amount: 1, base: 'USD', date, rates: { CNY: rate } }), { status: 200 }),
    ),
  );
}

type LatestEntry = { rate: number; source: string; fetchedAt: string; effectiveDate: string };
type GetBody = { latest: Record<string, LatestEntry>; history: Array<Record<string, unknown>> };

describe('FX rates routes (/api/workspace/fx-rates)', () => {
  beforeEach(async () => {
    await resetDb();
    mockFrankfurter(7.2154);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET requires a session (401 without auth)', async () => {
    const r = await api('GET', '/api/workspace/fx-rates');
    expect(r.status).toBe(401);
  });

  it('non-manager (purchaser) cannot read', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('GET', '/api/workspace/fx-rates', { token });
    expect(r.status).toBe(403);
  });

  it('manager GET returns latest + history after a refresh', async () => {
    const { token } = await loginAs(ALEX);
    const refresh = await api('POST', '/api/workspace/fx-rates/refresh', { token });
    expect(refresh.status).toBe(200);

    const r = await api<GetBody>('GET', '/api/workspace/fx-rates', { token });
    expect(r.status).toBe(200);
    expect(r.body.latest.CNY).toBeDefined();
    expect(r.body.latest.CNY.rate).toBeCloseTo(7.2154, 4);
    expect(r.body.latest.CNY.source).toBe('frankfurter');
    expect(Array.isArray(r.body.history)).toBe(true);
    expect(r.body.history.length).toBeGreaterThan(0);
  });

  it('manual override wins the latest lookup', async () => {
    const { token } = await loginAs(ALEX);
    const refresh = await api('POST', '/api/workspace/fx-rates/refresh', { token });
    expect(refresh.status).toBe(200);

    const post = await api('POST', '/api/workspace/fx-rates', {
      token,
      body: { quote: 'CNY', rate: 7.0, note: 'pinned for May invoice run' },
    });
    expect(post.status).toBe(201);

    const r = await api<GetBody>('GET', '/api/workspace/fx-rates', { token });
    expect(r.status).toBe(200);
    expect(r.body.latest.CNY.rate).toBeCloseTo(7.0, 4);
    expect(r.body.latest.CNY.source).toBe('manual');
  });

  it('POST rejects unsupported currency', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ error: string }>('POST', '/api/workspace/fx-rates', {
      token,
      body: { quote: 'EUR', rate: 1.1 },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/quote/i);
  });
});
