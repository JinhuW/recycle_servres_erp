import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// Mirror fx-routes.test.ts: vi.stubGlobal('fetch', ...) returning the
// Frankfurter response shape. The token-only public endpoints have no
// cookie/CSRF surface so the existing `api` helper is fine.
function mockFrankfurter(rate: number, date = '2026-05-26') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ amount: 1, base: 'USD', date, rates: { CNY: rate } }),
        { status: 200 },
      ),
    ),
  );
}

async function seedLink(): Promise<{ token: string; mgr: string }> {
  const { token: mgr } = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/customers', {
    token: mgr, body: { name: 'FX Vendor Co', shortName: 'FXCo' },
  });
  const link = await api<{ token: string }>(
    'POST', `/api/customers/${created.body.id}/vendor-link`, { token: mgr });
  return { token: link.body.token, mgr };
}

async function anInStockLine(mgr: string, minQty = 1): Promise<{ id: string; qty: number }> {
  const inv = await api<{ items: Array<{ id: string; qty: number; status: string }> }>(
    'GET', '/api/inventory?status=Done', { token: mgr });
  const row = inv.body.items.find(i => i.qty >= minQty)!;
  return { id: row.id, qty: row.qty };
}

describe('vendor public — bid currency', () => {
  beforeEach(async () => {
    await resetDb();
    mockFrankfurter(7.2154);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to USD when currency omitted', async () => {
    const { token, mgr } = await seedLink();
    const line = await anInStockLine(mgr);
    const r = await api<{ bidId: string }>('POST', `/api/public/vendor/${token}/bids`, {
      body: { contactName: 'Lin', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
    });
    expect(r.status).toBe(201);

    const sql = getTestDb();
    const rows = await sql<{ currency_code: string; fx_rate_to_usd: string; fx_source: string }[]>`
      SELECT currency_code, fx_rate_to_usd::text AS fx_rate_to_usd, fx_source
      FROM vendor_bids WHERE id = ${r.body.bidId}
    `;
    expect(rows[0].currency_code).toBe('USD');
    expect(Number(rows[0].fx_rate_to_usd)).toBeCloseTo(1, 6);
    expect(rows[0].fx_source).toBe('manual');
  });

  it('CNY bid records a frozen Frankfurter rate', async () => {
    const { token, mgr } = await seedLink();
    const line = await anInStockLine(mgr);
    const r = await api<{ bidId: string }>('POST', `/api/public/vendor/${token}/bids`, {
      body: {
        contactName: 'Lin',
        currency: 'CNY',
        lines: [{ inventoryId: line.id, qty: 1, unitPrice: 78 }],
      },
    });
    expect(r.status).toBe(201);

    const sql = getTestDb();
    const rows = await sql<{ currency_code: string; fx_rate_to_usd: string; fx_source: string }[]>`
      SELECT currency_code, fx_rate_to_usd::text AS fx_rate_to_usd, fx_source
      FROM vendor_bids WHERE id = ${r.body.bidId}
    `;
    expect(rows[0].currency_code).toBe('CNY');
    expect(Number(rows[0].fx_rate_to_usd)).toBeCloseTo(1 / 7.2154, 6);
    expect(rows[0].fx_source).toBe('frankfurter');
  });

  it('rejects an unsupported currency with 400', async () => {
    const { token, mgr } = await seedLink();
    const line = await anInStockLine(mgr);
    const r = await api<{ error: string }>('POST', `/api/public/vendor/${token}/bids`, {
      body: {
        contactName: 'Lin',
        currency: 'EUR',
        lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }],
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/currency/i);
  });

  it('GET /:token/fx returns the latest USD↔CNY pair', async () => {
    const { token } = await seedLink();
    const r = await api<{ USD_CNY: number; source: string; fetchedAt: string; effectiveDate: string }>(
      'GET', `/api/public/vendor/${token}/fx`);
    expect(r.status).toBe(200);
    expect(r.body.USD_CNY).toBeCloseTo(7.2154, 4);
    expect(typeof r.body.fetchedAt).toBe('string');
    expect(typeof r.body.effectiveDate).toBe('string');
  });

  it('GET /:token/bids exposes currency, fxRateToUsd, fxSource, usdEquivalent', async () => {
    const { token, mgr } = await seedLink();
    const line = await anInStockLine(mgr, 10);
    const sub = await api('POST', `/api/public/vendor/${token}/bids`, {
      body: {
        contactName: 'Lin',
        currency: 'CNY',
        lines: [{ inventoryId: line.id, qty: 10, unitPrice: 78 }],
      },
    });
    expect(sub.status).toBe(201);

    const r = await api<{ bids: Array<{
      currency: string; fxRateToUsd: number; fxSource: string; usdEquivalent: number;
    }> }>('GET', `/api/public/vendor/${token}/bids`);
    expect(r.status).toBe(200);
    expect(r.body.bids.length).toBeGreaterThan(0);
    const b = r.body.bids[0];
    expect(b.currency).toBe('CNY');
    expect(b.fxRateToUsd).toBeCloseTo(1 / 7.2154, 6);
    expect(b.fxSource).toBe('frankfurter');
    // 10 * 78 = 780 CNY; 780 / 7.2154 ≈ 108.10 USD
    expect(b.usdEquivalent).toBeCloseTo(108.10, 1);
  });
});
