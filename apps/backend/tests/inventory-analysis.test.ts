import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type Analysis = {
  totals: { lines: number; units: number };
  value: { cost: number; sell: number };
  byCategory: { category: string; lines: number; units: number; cost: number; sell: number }[];
  byStatus: { status: string; units: number }[];
  byWarehouse: { id: string; short: string; region: string; units: number; value: number; matrix: Record<string, number> }[];
  categories: string[];
  brands: [string, number][];
  subtypes: Record<string, { units: number; cost: number; sell: number; lines: number; dims: { key: string; data: [string, number][] }[]; condition: [string, number][]; sparse: boolean }>;
};

// The Analysis page is manager-only and whole-workspace (inventory is never
// role-preview scoped). The endpoint returns ONE aggregate snapshot; the page
// applies the category/warehouse view filters client-side. These assertions are
// seed-agnostic — they check internal consistency, not hard-coded counts.
describe('GET /api/inventory/analysis', () => {
  beforeEach(async () => { await resetDb(); });

  it('is manager-only (purchaser gets 403)', async () => {
    const { token } = await loginAs(MARCUS);
    const res = await api('GET', '/api/inventory/analysis', { token });
    expect(res.status).toBe(403);
  });

  it('returns an internally consistent aggregate snapshot', async () => {
    const { token } = await loginAs(ALEX);
    const res = await api<Analysis>('GET', '/api/inventory/analysis', { token });
    expect(res.status).toBe(200);
    const b = res.body;

    // Category breakdown sums to the grand total.
    expect(b.byCategory.reduce((s, r) => s + r.units, 0)).toBe(b.totals.units);
    // Status breakdown sums to the grand total.
    expect(b.byStatus.reduce((s, r) => s + r.units, 0)).toBe(b.totals.units);

    // Each warehouse's category matrix sums to that warehouse's unit total…
    for (const w of b.byWarehouse) {
      const m = Object.values(w.matrix).reduce((s, n) => s + n, 0);
      expect(m).toBe(w.units);
    }
    // …and warehouse-assigned units never exceed the grand total.
    expect(b.byWarehouse.reduce((s, w) => s + w.units, 0)).toBeLessThanOrEqual(b.totals.units);

    // Sub-analysis exists for the canonical types and agrees with the category roll-up.
    for (const cat of ['RAM', 'HDD', 'SSD', 'Other']) {
      const catRow = b.byCategory.find(r => r.category === cat);
      if (!catRow) continue;
      expect(b.subtypes[cat]).toBeTruthy();
      expect(b.subtypes[cat]!.units).toBe(catRow.units);
    }
  });
});
