import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { CLOSE_REASON_IDS } from '@recycle-erp/shared';

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

async function toDone(token: string, sellOrderId: string) {
  return api('POST', `/api/sell-orders/${sellOrderId}/status`, {
    token, body: { to: 'Done' },
  });
}

// The market board is USD; a completed sale should leave one data point per
// sold product. See docs/superpowers/specs/2026-07-05-sell-order-market-datapoint-design.md
describe('sell order Done → market data point', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('records last_price + one event for a sold part (auto-creating the row)', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const pn = 'SALE-DP-NEW-001';

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM',
        label: 'Sold RAM', subLabel: 'RDIMM', partNumber: pn, qty: 1, unitPrice: 55 }] },
    });
    expect(create.status).toBe(201);
    expect((await toDone(token, create.body.id)).status).toBe(200);

    const sql = getTestDb();
    const rp = (await sql<{ id: string; last_price: number; last_price_source: string;
      samples: number; label: string }[]>`
      SELECT id, last_price::float AS last_price, last_price_source, samples, label
      FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `)[0];
    expect(rp.last_price).toBe(55);
    expect(rp.last_price_source).toBe(`sale:${create.body.id}`);
    expect(rp.label).toBe('Sold RAM');
    expect(rp.samples).toBe(0); // aggregate untouched by a sale

    const events = await sql<{ price: number; source: string }[]>`
      SELECT price::float AS price, source FROM ref_price_events WHERE ref_price_id = ${rp.id}
    `;
    expect(events).toHaveLength(1);
    expect(events[0].price).toBe(55);
  });

  it('rolls up same-PN lines into one qty-weighted data point', async () => {
    const { token } = await loginAs(ALEX);
    const a = await freeSellableLine(token, 1);
    const b = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const pn = 'SALE-DP-ROLLUP-001';

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [
        { inventoryId: a.id, category: 'RAM', label: 'x', partNumber: pn, qty: 2, unitPrice: 100 },
        { inventoryId: b.id, category: 'RAM', label: 'x', partNumber: pn, qty: 3, unitPrice: 50 },
      ] },
    });
    expect(create.status).toBe(201);
    expect((await toDone(token, create.body.id)).status).toBe(200);

    const sql = getTestDb();
    const rp = (await sql<{ id: string; last_price: number }[]>`
      SELECT id, last_price::float AS last_price FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `)[0];
    // (2·100 + 3·50) / (2+3) = 350/5 = 70
    expect(rp.last_price).toBe(70);
    const events = await sql<{ price: number }[]>`
      SELECT price::float AS price FROM ref_price_events WHERE ref_price_id = ${rp.id}
    `;
    expect(events).toHaveLength(1);
    expect(events[0].price).toBe(70);
  });

  it('skips lines with no part number', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const sql = getTestDb();
    const before = (await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM ref_price_events`)[0].c;

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM',
        label: 'no-pn', qty: 1, unitPrice: 40 }] },
    });
    expect(create.status).toBe(201);
    expect((await toDone(token, create.body.id)).status).toBe(200);

    const after = (await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM ref_price_events`)[0].c;
    expect(after).toBe(before);
  });

  it('records the USD unit_price for a CNY order, not the native price', async () => {
    // fx.ts stores rates as USD→quote (how many CNY per 1 USD) and converts
    // native→USD via 1/stored. The route's mock in sell-order-currency.test.ts
    // (mockFrankfurter) uses this same { amount, base, date, rates: { CNY } }
    // shape — the brief's flat { rates: { USD } } shape doesn't match what
    // fx.ts reads for a CNY quote (it looks up rates.CNY, not rates.USD), so
    // it's adapted here to make CNY order creation actually succeed.
    const RATE_TO_USD = 0.14;              // 1 CNY = 0.14 USD
    const RATE_USD_CNY = 1 / RATE_TO_USD;  // 1 USD = ~7.142857 CNY (stored form)
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ amount: 1, base: 'USD', date: '2026-07-05', rates: { CNY: RATE_USD_CNY } }), { status: 200 })));
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const pn = 'SALE-DP-CNY-001';

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, currency: 'CNY', lines: [{ inventoryId: line.id, category: 'RAM',
        label: 'x', partNumber: pn, qty: 1, unitPrice: 100 }] },
    });
    expect(create.status).toBe(201);
    expect((await toDone(token, create.body.id)).status).toBe(200);

    const sql = getTestDb();
    const rp = (await sql<{ last_price: number }[]>`
      SELECT last_price::float AS last_price FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `)[0];
    // Stored unit_price is USD: 100 CNY × 0.14 = 14.00.
    expect(rp.last_price).toBeCloseTo(14, 2);
  });

  it('does not record a data point when the order is Closed', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const pn = 'SALE-DP-CLOSED-001';

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM',
        label: 'x', partNumber: pn, qty: 1, unitPrice: 33 }] },
    });
    expect(create.status).toBe(201);
    const closed = await api('POST', `/api/sell-orders/${create.body.id}/status`, {
      token, body: { to: 'Closed', closeReasonId: CLOSE_REASON_IDS[0] },
    });
    expect(closed.status).toBe(200);

    const sql = getTestDb();
    const rows = await sql<{ id: string }[]>`SELECT id FROM ref_prices WHERE part_number = ${pn}`;
    expect(rows).toHaveLength(0);
  });
});
