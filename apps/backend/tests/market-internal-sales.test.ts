import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import type { MarketValue } from '../src/lib/market';

// GET /api/market populates the per-row `internalSales` aggregate from PO
// order_lines.sell_price over the last 30 days, keyed by canonical
// part_number (same rule as elsewhere in the codebase). The
// "Internal sales (last 30d)" row in the desktop Market Value detail
// renders this directly instead of the synthetic broker offset.

describe('GET /api/market — internalSales aggregate (PO last 30d)', () => {
  beforeEach(async () => { await resetDb(); });

  it('returns avgPrice + samples from PO sell_price for matching part_number', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const { token: aTok } = await loginAs(ALEX);
    const pn = 'TEST-INTSALES-001';

    // Two PO lines with sell_price set; their avg becomes the internal-sales avg.
    await api('POST', '/api/orders', {
      token: pTok,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1',
        lines: [
          { category: 'RAM', partNumber: pn, condition: 'New', qty: 1, unitCost: 10, sellPrice: 30 },
          { category: 'RAM', partNumber: pn, condition: 'New', qty: 1, unitCost: 12, sellPrice: 50 },
        ],
      },
    });

    // A line with no sell_price is excluded (NULL check in the CTE).
    await api('POST', '/api/orders', {
      token: pTok,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1',
        lines: [{ category: 'RAM', partNumber: pn, condition: 'New', qty: 1, unitCost: 8 }],
      },
    });

    const r = await api<{ items: MarketValue[] }>(
      'GET', `/api/market?q=${encodeURIComponent(pn)}`, { token: aTok });
    expect(r.status).toBe(200);
    const row = r.body.items.find(i => i.partNumber === pn);
    expect(row, 'auto-tracked ref_prices row for the novel PN').toBeTruthy();
    expect(row!.internalSales.samples).toBe(2);
    expect(row!.internalSales.avgPrice).toBeCloseTo(40, 5);
  });

  it('reports samples=0 and avgPrice=null when no matching PO lines exist', async () => {
    const { token } = await loginAs(ALEX);
    // The seeded `ref_prices` rows for which no PO line carries the same PN
    // should still come back with an internalSales block, just zeroed out.
    const r = await api<{ items: MarketValue[] }>('GET', '/api/market', { token });
    expect(r.status).toBe(200);
    const noMatch = r.body.items.find(i => i.internalSales.samples === 0);
    expect(noMatch, 'at least one seeded row with no recent PO sell_price').toBeTruthy();
    expect(noMatch!.internalSales.avgPrice).toBeNull();
  });

  it('matches via canonical part_number (case + whitespace + prefix insensitive)', async () => {
    const { token: pTok } = await loginAs(MARCUS);
    const { token: aTok } = await loginAs(ALEX);

    // PO stores a noisy variant; ref_prices is auto-created from the same
    // line, so both sides canonicalise to the same key.
    await api('POST', '/api/orders', {
      token: pTok,
      body: {
        category: 'RAM', warehouseId: 'WH-LA1',
        lines: [
          { category: 'RAM', partNumber: '  pn: noisy-canon-abc  ', condition: 'New', qty: 1, unitCost: 5, sellPrice: 25 },
        ],
      },
    });

    const r = await api<{ items: MarketValue[] }>(
      'GET', `/api/market?q=${encodeURIComponent('noisy-canon-abc')}`, { token: aTok });
    expect(r.status).toBe(200);
    // Whichever row matches (we don't pin the exact part_number text — the
    // auto-track helper stores the raw form), it should have 1 sample at 25.
    const hits = r.body.items.filter(i => i.internalSales.samples > 0);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].internalSales.avgPrice).toBeCloseTo(25, 5);
  });
});
