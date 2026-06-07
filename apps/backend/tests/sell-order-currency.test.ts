import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

// Per-order currency on sell orders (migration 0065). USD line values still
// live in sell_order_lines.unit_price; native facts live in the source_*
// audit columns. Frankfurter is stubbed so the snapshot rate is deterministic.

const RATE_USD_CNY = 7.2154;            // 1 USD = 7.2154 CNY
const RATE_TO_USD = 1 / RATE_USD_CNY;   // multiplier native→USD (~0.138583)

function mockFrankfurter(rate = RATE_USD_CNY, date = '2026-06-07') {
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

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].id;
}

type SODetail = {
  order: {
    currency: string; fxRateToUsd: number; fxSource: string;
    subtotal: number; nativeSubtotal: number; total: number; nativeTotal: number;
    lines: { unitPrice: number; nativeUnitPrice: number; qty: number }[];
  };
};

describe('sell orders — per-order currency', () => {
  beforeEach(async () => {
    await resetDb();
    mockFrankfurter();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('creates a CNY order: line USD = native × rate, audit cols stamped', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        currency: 'CNY',
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn', qty: 2, unitPrice: 78 }],
      },
    });
    expect(create.status).toBe(201);

    const got = await api<SODetail>('GET', `/api/sell-orders/${create.body.id}`, { token });
    const { order } = got.body;
    expect(order.currency).toBe('CNY');
    expect(order.fxRateToUsd).toBeCloseTo(RATE_TO_USD, 6);
    expect(order.fxSource).toBe('frankfurter');

    const l = order.lines[0];
    expect(l.nativeUnitPrice).toBe(78);
    expect(l.unitPrice).toBeCloseTo(Math.round(78 * RATE_TO_USD * 100) / 100, 2);
    // Native subtotal is in CNY; USD subtotal is the converted value.
    expect(order.nativeSubtotal).toBeCloseTo(156, 2);
    expect(order.subtotal).toBeCloseTo(l.unitPrice * 2, 2);

    // Audit columns on the row itself.
    const sql = getTestDb();
    const [row] = await sql<{ source_currency: string | null; source_unit_price: string | null }[]>`
      SELECT source_currency, source_unit_price::float AS source_unit_price
      FROM sell_order_lines WHERE sell_order_id = ${create.body.id}
    `;
    expect(row.source_currency).toBe('CNY');
    expect(Number(row.source_unit_price)).toBe(78);
  });

  it('USD order is unchanged: native == USD, no audit cols', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn', qty: 1, unitPrice: 100 }] },
    });
    const got = await api<SODetail>('GET', `/api/sell-orders/${create.body.id}`, { token });
    expect(got.body.order.currency).toBe('USD');
    expect(got.body.order.fxRateToUsd).toBe(1);
    expect(got.body.order.lines[0].nativeUnitPrice).toBe(100);
    expect(got.body.order.lines[0].unitPrice).toBe(100);

    const sql = getTestDb();
    const [row] = await sql<{ source_currency: string | null }[]>`
      SELECT source_currency FROM sell_order_lines WHERE sell_order_id = ${create.body.id}
    `;
    expect(row.source_currency).toBeNull();
  });

  it('rejects an unsupported currency', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const create = await api('POST', '/api/sell-orders', {
      token,
      body: { customerId, currency: 'EUR', lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn', qty: 1, unitPrice: 10 }] },
    });
    expect(create.status).toBe(400);
  });

  it('PATCH USD→CNY re-prices lines; currency without lines is rejected', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn', qty: 1, unitPrice: 100 }] },
    });
    const soId = create.body.id;

    // currency change without lines → 400
    const bad = await api('PATCH', `/api/sell-orders/${soId}`, { token, body: { currency: 'CNY' } });
    expect(bad.status).toBe(400);

    // currency change with native lines → re-priced
    const ok = await api('PATCH', `/api/sell-orders/${soId}`, {
      token,
      body: { currency: 'CNY', lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'pn', qty: 1, unitPrice: 700 }] },
    });
    expect(ok.status).toBe(200);

    const got = await api<SODetail>('GET', `/api/sell-orders/${soId}`, { token });
    expect(got.body.order.currency).toBe('CNY');
    expect(got.body.order.lines[0].nativeUnitPrice).toBe(700);
    expect(got.body.order.lines[0].unitPrice).toBeCloseTo(Math.round(700 * RATE_TO_USD * 100) / 100, 2);
  });
});
