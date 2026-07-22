import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { eventsOf } from './helpers/sellOrderEvents';
import { prorateLines, validateTarget } from '../src/services/sellOrderPriceAdjust';

// Negotiated final-price adjustment: POST /:id/adjust-price prorates the
// buyer's counter-offer across line unit prices so total === Σ lines holds.
// See docs/superpowers/specs/2026-07-22-negotiated-price-adjustment-design.md

const RATE_USD_CNY = 7.2154;
const RATE_TO_USD = 1 / RATE_USD_CNY;

function mockFrankfurter(rate = RATE_USD_CNY, date = '2026-07-22') {
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

describe('prorateLines', () => {
  it('hits the target exactly when every qty is 1', () => {
    const r = prorateLines(
      [{ qty: 1, price: 100 }, { qty: 1, price: 50 }, { qty: 1, price: 33.37 }],
      150,
    );
    expect(r.achievedTotal).toBe(150);
    expect(r.prices.reduce((a, p) => a + p, 0)).toBeCloseTo(150, 2);
  });

  it('spreads a clean percentage cut proportionally', () => {
    // 2×100 + 3×50 = 350 → 315 is a flat −10%.
    const r = prorateLines([{ qty: 2, price: 100 }, { qty: 3, price: 50 }], 315);
    expect(r.prices).toEqual([90, 45]);
    expect(r.achievedTotal).toBe(315);
  });

  it('is deterministic and bounds the gap below the smallest bumpable qty', () => {
    const lines = [{ qty: 3, price: 100 }, { qty: 7, price: 41.13 }];
    const a = prorateLines(lines, 500.55);
    const b = prorateLines(lines, 500.55);
    expect(a).toEqual(b);
    expect(a.achievedTotal).toBeLessThanOrEqual(500.55);
    // Any leftover must be smaller than the cheapest possible bump (min qty).
    expect(500.55 - a.achievedTotal).toBeLessThan(0.03);
    expect(a.achievedTotal).toBe(
      +lines.reduce((s, l, i) => s + l.qty * a.prices[i], 0).toFixed(2),
    );
  });

  it('never touches zero-price lines', () => {
    const r = prorateLines([{ qty: 2, price: 100 }, { qty: 5, price: 0 }], 150);
    expect(r.prices[1]).toBe(0);
    expect(r.prices[0]).toBe(75);
  });

  it('single multi-qty line lands on the nearest reachable total below target', () => {
    // qty 3 → totals move in 3-cent steps; 200 is unreachable from 100.00.
    const r = prorateLines([{ qty: 3, price: 100 }], 200);
    expect(r.achievedTotal).toBe(199.98);
    expect(r.prices[0]).toBe(66.66);
  });

  it('supports negotiating the price upward', () => {
    const r = prorateLines([{ qty: 2, price: 100 }, { qty: 3, price: 50 }], 385);
    expect(r.prices).toEqual([110, 55]);
    expect(r.achievedTotal).toBe(385);
  });

  it('validateTarget rejects bad targets and zero-total orders', () => {
    const lines = [{ qty: 1, price: 100 }];
    expect(validateTarget(lines, 0)).toBeTruthy();
    expect(validateTarget(lines, -5)).toBeTruthy();
    expect(validateTarget(lines, 99.999)).toBeTruthy();
    expect(validateTarget(lines, Number.NaN)).toBeTruthy();
    expect(validateTarget(lines, 9500.55)).toBeNull();
    expect(validateTarget([{ qty: 4, price: 0 }], 50)).toBeTruthy();
  });
});

describe('POST /api/sell-orders/:id/adjust-price', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function createUsdOrder(token: string, unitPrice = 100, qty = 1) {
    const line = await freeSellableLine(token, qty);
    const customerId = await firstCustomerId(token);
    const r = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'x',
          partNumber: 'ADJ-PN-1', qty, unitPrice }],
      },
    });
    expect(r.status).toBe(201);
    return r.body.id;
  }

  it('is forbidden for non-managers', async () => {
    const { token: managerTok } = await loginAs(ALEX);
    const id = await createUsdOrder(managerTok);
    const { token } = await loginAs(MARCUS);
    const r = await api('POST', `/api/sell-orders/${id}/adjust-price`, {
      token, body: { targetTotal: 90 },
    });
    expect(r.status).toBe(403);
  });

  it('404s on an unknown order', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/sell-orders/SO-99999/adjust-price', {
      token, body: { targetTotal: 90 },
    });
    expect(r.status).toBe(404);
  });

  it('409s once the order is Done or Closed', async () => {
    const { token } = await loginAs(ALEX);
    const done = await createUsdOrder(token);
    await api('POST', `/api/sell-orders/${done}/status`, { token, body: { to: 'Done' } });
    const r1 = await api('POST', `/api/sell-orders/${done}/adjust-price`, {
      token, body: { targetTotal: 90 },
    });
    expect(r1.status).toBe(409);

    const closed = await createUsdOrder(token);
    await api('POST', `/api/sell-orders/${closed}/status`, {
      token, body: { to: 'Closed', closeReasonId: 'customer_cancelled' },
    });
    const r2 = await api('POST', `/api/sell-orders/${closed}/adjust-price`, {
      token, body: { targetTotal: 90 },
    });
    expect(r2.status).toBe(409);
  });

  it('rejects invalid targets with 400', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createUsdOrder(token);
    for (const targetTotal of [0, -10, 99.999]) {
      const r = await api('POST', `/api/sell-orders/${id}/adjust-price`, {
        token, body: { targetTotal },
      });
      expect(r.status).toBe(400);
    }
    const missing = await api('POST', `/api/sell-orders/${id}/adjust-price`, {
      token, body: {},
    });
    expect(missing.status).toBe(400);
  });

  it('adjusts a USD Draft order: lines, header metadata, and one event', async () => {
    const { token, user } = await loginAs(ALEX);
    const id = await createUsdOrder(token, 100, 1);

    const r = await api<{ ok: boolean; achievedTotal: number }>(
      'POST', `/api/sell-orders/${id}/adjust-price`,
      { token, body: { targetTotal: 90 } },
    );
    expect(r.status).toBe(200);
    expect(r.body.achievedTotal).toBe(90);

    const sql = getTestDb();
    const [line] = await sql<{ unit_price: number; source_unit_price: number | null }[]>`
      SELECT unit_price::float AS unit_price, source_unit_price::float AS source_unit_price
      FROM sell_order_lines WHERE sell_order_id = ${id}
    `;
    expect(line.unit_price).toBe(90);
    expect(line.source_unit_price).toBeNull();

    const [head] = await sql<{
      pre_adjust_native_total: number; adjusted_by: string; adjusted_at: string;
    }[]>`
      SELECT pre_adjust_native_total::float AS pre_adjust_native_total,
             adjusted_by, adjusted_at
      FROM sell_orders WHERE id = ${id}
    `;
    expect(head.pre_adjust_native_total).toBe(100);
    expect(head.adjusted_by).toBe(user.id);
    expect(head.adjusted_at).toBeTruthy();

    const events = (await eventsOf(id)).filter(e => e.kind === 'price_adjusted');
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({
      fromTotal: 100, toTotal: 90, requestedTotal: 90, currency: 'USD', pct: -10,
    });
  });

  it('works while Shipped (read-only editor stage)', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createUsdOrder(token);
    await api('POST', `/api/sell-orders/${id}/status`, {
      token, body: { to: 'Shipped', note: 's' },
    });
    const r = await api('POST', `/api/sell-orders/${id}/adjust-price`, {
      token, body: { targetTotal: 95 },
    });
    expect(r.status).toBe(200);
  });

  it('CNY order: native prices sum to the achieved total, USD re-derived at the frozen rate', async () => {
    mockFrankfurter();
    const { token } = await loginAs(ALEX);
    const a = await freeSellableLine(token, 2);
    const b = await freeSellableLine(token, 3, new Set([a.id]));
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId, currency: 'CNY',
        lines: [
          { inventoryId: a.id, category: 'RAM', label: 'x', partNumber: 'ADJ-CNY-1', qty: 2, unitPrice: 100 },
          { inventoryId: b.id, category: 'RAM', label: 'x', partNumber: 'ADJ-CNY-2', qty: 3, unitPrice: 50 },
        ],
      },
    });
    expect(create.status).toBe(201);
    const id = create.body.id;

    // 350 CNY → 315 CNY is a flat −10%, so per-line native prices are exact.
    const r = await api<{ achievedTotal: number }>(
      'POST', `/api/sell-orders/${id}/adjust-price`,
      { token, body: { targetTotal: 315 } },
    );
    expect(r.status).toBe(200);
    expect(r.body.achievedTotal).toBe(315);

    const sql = getTestDb();
    const rows = await sql<{
      qty: number; unit_price: number; source_unit_price: number;
    }[]>`
      SELECT qty, unit_price::float AS unit_price,
             source_unit_price::float AS source_unit_price
      FROM sell_order_lines WHERE sell_order_id = ${id} ORDER BY position
    `;
    expect(rows.map(x => x.source_unit_price)).toEqual([90, 45]);
    const nativeSum = rows.reduce((s, x) => s + x.qty * x.source_unit_price, 0);
    expect(nativeSum).toBe(315);
    for (const row of rows) {
      expect(row.unit_price).toBeCloseTo(
        Math.round(row.source_unit_price * RATE_TO_USD * 100) / 100, 2,
      );
    }
  });

  it('keeps the first pre-adjustment baseline across repeated adjustments', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createUsdOrder(token, 100, 1);
    await api('POST', `/api/sell-orders/${id}/adjust-price`, { token, body: { targetTotal: 90 } });
    await api('POST', `/api/sell-orders/${id}/adjust-price`, { token, body: { targetTotal: 80 } });

    const sql = getTestDb();
    const [head] = await sql<{ pre_adjust_native_total: number }[]>`
      SELECT pre_adjust_native_total::float AS pre_adjust_native_total
      FROM sell_orders WHERE id = ${id}
    `;
    expect(head.pre_adjust_native_total).toBe(100);

    const events = (await eventsOf(id)).filter(e => e.kind === 'price_adjusted');
    expect(events).toHaveLength(2);
    expect(events[0].detail).toMatchObject({ fromTotal: 100, toTotal: 90 });
    expect(events[1].detail).toMatchObject({ fromTotal: 90, toTotal: 80 });
  });

  it('a PATCH line rewrite clears the adjustment metadata', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 2);
    const customerId = await firstCustomerId(token);
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'x',
          partNumber: 'ADJ-RESET-1', qty: 1, unitPrice: 100 }],
      },
    });
    const id = create.body.id;
    await api('POST', `/api/sell-orders/${id}/adjust-price`, { token, body: { targetTotal: 90 } });

    const patch = await api('PATCH', `/api/sell-orders/${id}`, {
      token,
      body: {
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'x',
          partNumber: 'ADJ-RESET-1', qty: 2, unitPrice: 90 }],
      },
    });
    expect(patch.status).toBe(200);

    const sql = getTestDb();
    const [head] = await sql<{
      pre_adjust_native_total: number | null; adjusted_at: string | null; adjusted_by: string | null;
    }[]>`
      SELECT pre_adjust_native_total::float AS pre_adjust_native_total, adjusted_at, adjusted_by
      FROM sell_orders WHERE id = ${id}
    `;
    expect(head.pre_adjust_native_total).toBeNull();
    expect(head.adjusted_at).toBeNull();
    expect(head.adjusted_by).toBeNull();
    // The immutable timeline keeps the adjustment event.
    const events = (await eventsOf(id)).filter(e => e.kind === 'price_adjusted');
    expect(events).toHaveLength(1);
  });

  it('a notes-only PATCH keeps the adjustment metadata', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createUsdOrder(token);
    await api('POST', `/api/sell-orders/${id}/adjust-price`, { token, body: { targetTotal: 90 } });
    await api('PATCH', `/api/sell-orders/${id}`, { token, body: { notes: 'still adjusted' } });

    const sql = getTestDb();
    const [head] = await sql<{ pre_adjust_native_total: number | null }[]>`
      SELECT pre_adjust_native_total::float AS pre_adjust_native_total
      FROM sell_orders WHERE id = ${id}
    `;
    expect(head.pre_adjust_native_total).toBe(100);
  });

  it('GET /:id exposes priceAdjustment; market datapoint on Done uses the adjusted price', async () => {
    const { token, user } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1);
    const customerId = await firstCustomerId(token);
    const pn = 'ADJ-MARKET-001';
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'x',
          partNumber: pn, qty: 1, unitPrice: 100 }],
      },
    });
    const id = create.body.id;
    await api('POST', `/api/sell-orders/${id}/adjust-price`, { token, body: { targetTotal: 88 } });

    const got = await api<{ order: {
      nativeTotal: number;
      priceAdjustment: {
        preAdjustNativeTotal: number; adjustedAt: string;
        adjustedBy: { id: string; name: string } | null;
      } | null;
    } }>('GET', `/api/sell-orders/${id}`, { token });
    expect(got.body.order.nativeTotal).toBe(88);
    expect(got.body.order.priceAdjustment).toMatchObject({
      preAdjustNativeTotal: 100,
      adjustedBy: { id: user.id },
    });

    await api('POST', `/api/sell-orders/${id}/status`, { token, body: { to: 'Done' } });
    const sql = getTestDb();
    const [rp] = await sql<{ last_price: number }[]>`
      SELECT last_price::float AS last_price FROM ref_prices WHERE part_number = ${pn} LIMIT 1
    `;
    expect(rp.last_price).toBe(88);
  });
});
