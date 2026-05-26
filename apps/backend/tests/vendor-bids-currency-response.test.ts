import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// Mirror the FX-aware tests: stub Frankfurter so the public submit path
// freezes a deterministic rate on vendor_bids.fx_rate_to_usd. Manager-side
// list/detail then echo those columns back as response fields.
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

async function seedLink(name: string, short: string): Promise<{ token: string; mgr: string }> {
  const { token: mgr } = await loginAs(ALEX);
  const created = await api<{ id: string }>('POST', '/api/customers', {
    token: mgr, body: { name, shortName: short },
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

type ListBid = {
  id: string;
  total_offered: number;
  currency: string;
  fxRateToUsd: number;
  fxSource: string;
  totalOfferedUsd: number;
};

type DetailLine = {
  id: string;
  offered_qty: number;
  offered_unit_price: number;
  unitPriceUsd: number;
};

type DetailBid = {
  id: string;
  currency: string;
  fxRateToUsd: number;
  fxSource: string;
  lines: DetailLine[];
};

describe('manager vendor-bids list/detail — currency response shape', () => {
  beforeEach(async () => {
    await resetDb();
    mockFrankfurter(7.2154);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('USD bid surfaces currency:USD, rate=1, source=manual, totalOfferedUsd === totalOffered', async () => {
    const { token, mgr } = await seedLink('USD Inbox Co', 'USDIN');
    const line = await anInStockLine(mgr, 1);
    const sub = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${token}/bids`, {
        body: { contactName: 'Lin', lines: [{ inventoryId: line.id, qty: 1, unitPrice: 5 }] },
      });
    expect(sub.status).toBe(201);

    const r = await api<{ items: ListBid[] }>('GET', '/api/vendor-bids', { token: mgr });
    expect(r.status).toBe(200);
    const b = r.body.items.find(it => it.id === sub.body.bidId)!;
    expect(b).toBeTruthy();
    expect(b.currency).toBe('USD');
    expect(b.fxRateToUsd).toBeCloseTo(1, 6);
    expect(b.fxSource).toBe('manual');
    expect(b.totalOfferedUsd).toBeCloseTo(b.total_offered, 2);
  });

  it('CNY bid surfaces frankfurter source + USD-equivalent total', async () => {
    const { token, mgr } = await seedLink('CNY Inbox Co', 'CNYIN');
    const line = await anInStockLine(mgr, 1);
    const sub = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${token}/bids`, {
        body: {
          contactName: 'Lin',
          currency: 'CNY',
          lines: [{ inventoryId: line.id, qty: 1, unitPrice: 100 }],
        },
      });
    expect(sub.status).toBe(201);

    const r = await api<{ items: ListBid[] }>('GET', '/api/vendor-bids', { token: mgr });
    expect(r.status).toBe(200);
    const b = r.body.items.find(it => it.id === sub.body.bidId)!;
    expect(b).toBeTruthy();
    expect(b.currency).toBe('CNY');
    expect(b.fxRateToUsd).toBeCloseTo(1 / 7.2154, 6);
    expect(b.fxSource).toBe('frankfurter');
    // 1 * 100 CNY -> 100 / 7.2154 ≈ 13.86 USD (2dp)
    expect(b.totalOfferedUsd).toBeCloseTo(100 / 7.2154, 2);
    expect(b.totalOfferedUsd).toBeCloseTo(13.86, 2);
  });

  it('detail response carries currency head fields + per-line unitPriceUsd', async () => {
    const { token, mgr } = await seedLink('CNY Detail Co', 'CNYDT');
    const line = await anInStockLine(mgr, 10);
    const sub = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${token}/bids`, {
        body: {
          contactName: 'Lin',
          currency: 'CNY',
          lines: [{ inventoryId: line.id, qty: 10, unitPrice: 78 }],
        },
      });
    expect(sub.status).toBe(201);

    const r = await api<{ bid: DetailBid }>(
      'GET', `/api/vendor-bids/${sub.body.bidId}`, { token: mgr });
    expect(r.status).toBe(200);
    expect(r.body.bid.currency).toBe('CNY');
    expect(r.body.bid.fxRateToUsd).toBeCloseTo(1 / 7.2154, 6);
    expect(r.body.bid.fxSource).toBe('frankfurter');
    expect(r.body.bid.lines.length).toBe(1);
    // 78 CNY / 7.2154 ≈ 10.81 USD (2dp)
    expect(r.body.bid.lines[0].unitPriceUsd).toBeCloseTo(78 / 7.2154, 2);
    expect(r.body.bid.lines[0].unitPriceUsd).toBeCloseTo(10.81, 2);
  });
});
