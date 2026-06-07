import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

// Mirror vendor-public-bid-currency.test.ts: stub Frankfurter so the
// bid-submit path freezes a deterministic rate, then assert the promote
// path uses the rate FROZEN on the bid (not the live rate at promote time)
// + stamps the SO line audit cols.
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
    token: mgr, body: { name: 'FX Promote Co', shortName: 'FXPC' },
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

describe('vendor-bids promote — frozen fx + SO line audit', () => {
  beforeEach(async () => {
    await resetDb();
    mockFrankfurter(7.2154);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('CNY bid promotion stamps SO line audit cols + enriches created event', async () => {
    const { token, mgr } = await seedLink();
    const line = await anInStockLine(mgr, 1);

    const submit = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${token}/bids`, {
        body: {
          contactName: 'Lin',
          currency: 'CNY',
          lines: [{ inventoryId: line.id, qty: 1, unitPrice: 78 }],
        },
      });
    expect(submit.status).toBe(201);
    const bidId = submit.body.bidId;

    const detail = await api<{ bid: { lines: Array<{ id: string }> } }>(
      'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    const lineId = detail.body.bid.lines[0].id;

    const dec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr,
      body: { lines: [{ lineId, decision: 'accepted', acceptedQty: 1, acceptedUnitPrice: 78 }] },
    });
    expect(dec.status).toBe(200);

    // The live rate moves between submit and promote. The sell order must be
    // created at the rate frozen on the bid (7.2154), NOT this new one — the
    // manager approved a USD total computed from the frozen rate.
    mockFrankfurter(8.5, '2026-05-27');

    const prom = await api<{ sellOrderId: string }>(
      'POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
    expect(prom.status).toBe(201);
    const sellId = prom.body.sellOrderId;

    const sql = getTestDb();
    const rows = await sql<{
      source_currency: string | null;
      source_unit_price: string | null;
      source_fx_rate_to_usd: string | null;
      unit_price: string;
    }[]>`
      SELECT source_currency,
             source_unit_price::text AS source_unit_price,
             source_fx_rate_to_usd::text AS source_fx_rate_to_usd,
             unit_price::text AS unit_price
      FROM sell_order_lines WHERE sell_order_id = ${sellId} ORDER BY position
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].source_currency).toBe('CNY');
    expect(Number(rows[0].source_unit_price)).toBeCloseTo(78, 2);
    expect(Number(rows[0].source_fx_rate_to_usd)).toBeCloseTo(1 / 7.2154, 6);
    // 78 / 7.2154 ≈ 10.81
    expect(Number(rows[0].unit_price)).toBeCloseTo(78 / 7.2154, 2);

    const events = await sql<{ kind: string; detail: Record<string, unknown> }[]>`
      SELECT kind, detail FROM sell_order_events
      WHERE sell_order_id = ${sellId} AND kind = 'created'
    `;
    expect(events.length).toBe(1);
    const d = events[0].detail;
    expect(d.source).toBe('vendor_bid');
    expect(d.currency).toBe('CNY');
    expect(Number(d.fxRateToUsd)).toBeCloseTo(1 / 7.2154, 6);
    expect(['frankfurter', 'manual']).toContain(d.fxSource as string);
  });

  it('USD bid promotion leaves audit cols NULL', async () => {
    const { token, mgr } = await seedLink();
    const line = await anInStockLine(mgr, 1);

    const submit = await api<{ bidId: string }>(
      'POST', `/api/public/vendor/${token}/bids`, {
        body: {
          contactName: 'Lin',
          lines: [{ inventoryId: line.id, qty: 1, unitPrice: 25 }],
        },
      });
    expect(submit.status).toBe(201);
    const bidId = submit.body.bidId;

    const detail = await api<{ bid: { lines: Array<{ id: string }> } }>(
      'GET', `/api/vendor-bids/${bidId}`, { token: mgr });
    const lineId = detail.body.bid.lines[0].id;

    const dec = await api('POST', `/api/vendor-bids/${bidId}/decide`, {
      token: mgr,
      body: { lines: [{ lineId, decision: 'accepted', acceptedQty: 1, acceptedUnitPrice: 25 }] },
    });
    expect(dec.status).toBe(200);

    const prom = await api<{ sellOrderId: string }>(
      'POST', `/api/vendor-bids/${bidId}/promote`, { token: mgr });
    expect(prom.status).toBe(201);
    const sellId = prom.body.sellOrderId;

    const sql = getTestDb();
    const rows = await sql<{
      source_currency: string | null;
      source_unit_price: string | null;
      source_fx_rate_to_usd: string | null;
      unit_price: string;
    }[]>`
      SELECT source_currency,
             source_unit_price::text AS source_unit_price,
             source_fx_rate_to_usd::text AS source_fx_rate_to_usd,
             unit_price::text AS unit_price
      FROM sell_order_lines WHERE sell_order_id = ${sellId} ORDER BY position
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].source_currency).toBeNull();
    expect(rows[0].source_unit_price).toBeNull();
    expect(rows[0].source_fx_rate_to_usd).toBeNull();
    expect(Number(rows[0].unit_price)).toBeCloseTo(25, 2);
  });
});
