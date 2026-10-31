// Review 2026-10-31, lane A3 verification, claim A3-01.
// Asserts the claimed defect: a manual FX override has no sane upper bound.
// Run: cd docs/review-2026-10-31/repro/A3-verify &&
//   TEST_DATABASE_URL=postgres://postgres:review@127.0.0.1:55703/postgres \
//   ../../../../apps/backend/node_modules/.bin/vitest run --config vitest.config.ts a3-01
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from '../../../../apps/backend/tests/helpers/db';
import { api } from '../../../../apps/backend/tests/helpers/app';
import { loginAs, ALEX } from '../../../../apps/backend/tests/helpers/auth';
import { freeSellableLine } from '../../../../apps/backend/tests/helpers/inventory';
import { firstCustomerId } from '../../../../apps/backend/tests/helpers/fixtures';
import { mockFrankfurter } from '../../../../apps/backend/tests/helpers/fx';

describe('A3-01 manual FX override bound', () => {
  beforeEach(async () => { await resetDb(); mockFrankfurter(7.2, '2026-10-01'); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('7100 (typo for 7.10) is accepted and then prices a CNY sell order ~1000x low', async () => {
    const { token } = await loginAs(ALEX);
    const post = await api('POST', '/api/workspace/fx-rates', { token, body: { quote: 'CNY', rate: 7100 } });
    expect(post.status).toBe(201);

    const line = await freeSellableLine(token, 1);
    const so = await api<{ id: string }>('POST', '/api/sell-orders', {
      token, body: { customerId: await firstCustomerId(token), currency: 'CNY',
        lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', partNumber: 'A3V-FX', qty: 1, unitPrice: 710 }] },
    });
    expect(so.status).toBe(201);
    const [row] = await getTestDb()<{ unit_price: string }[]>`
      SELECT unit_price FROM sell_order_lines WHERE sell_order_id = ${so.body.id}`;
    console.log('A3-01 CNY 710 stored as USD unit_price =', row.unit_price);
    expect(Number(row.unit_price)).toBeLessThan(1); // should be ~100 USD
  });

  it('a USD RMB-Flow entry with no explicit rate then 500s on the fx_rate <= 100 CHECK', async () => {
    const alex = await loginAs(ALEX);
    expect((await api('POST', '/api/workspace/fx-rates', { token: alex.token, body: { quote: 'CNY', rate: 7100 } })).status).toBe(201);
    const r = await api<{ error?: string }>('POST', '/api/accounting/entries', {
      token: alex.token, body: { direction: 'out', kind: 'other', amount: 100, currency: 'USD', method: 'alipay',
        occurredOn: '2026-10-05', managerId: alex.user.id },
    });
    console.log('A3-01 accounting entry status =', r.status, r.body);
    expect(r.status).toBe(500);
  });

  it('a tiny positive rate passes the route check then 500s on fx_rates CHECK (rate > 0)', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/workspace/fx-rates', { token, body: { quote: 'CNY', rate: 1e-9 } });
    console.log('A3-01 tiny rate status =', r.status);
    expect(r.status).toBe(500);
  });
});
