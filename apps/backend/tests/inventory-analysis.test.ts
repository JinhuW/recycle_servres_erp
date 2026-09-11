import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type Subtype = {
  units: number; cost: number; sell: number; lines: number;
  dims: { key: string; data: [string, number][] }[];
  condition: [string, number][]; sparse: boolean;
};
type Analysis = {
  scope: { category: string | null; warehouse: string | null };
  totals: { lines: number; units: number };
  value: { cost: number; sell: number };
  byCategory: { category: string; lines: number; units: number; cost: number; sell: number }[];
  byStatus: { status: string; units: number }[];
  byWarehouse: { id: string; short: string; region: string; units: number; value: number }[];
  categories: string[];
  warehouses: { id: string; short: string; region: string }[];
  brands: [string, number][];
  subtypes: Record<string, Subtype>;
};

// The Analysis tab is manager-only and whole-workspace (inventory is never
// role-preview scoped). The endpoint is filter-aware — the page re-queries with
// ?category / ?warehouse and every section reflects the slice. These assertions
// are seed-agnostic — they check internal consistency, not hard-coded counts.
describe('GET /api/inventory/analysis', () => {
  beforeEach(async () => { await resetDb(); });

  it('is manager-only (purchaser gets 403)', async () => {
    const { token } = await loginAs(MARCUS);
    const res = await api('GET', '/api/inventory/analysis', { token });
    expect(res.status).toBe(403);
  });

  it('returns an internally consistent unfiltered snapshot', async () => {
    const { token } = await loginAs(ALEX);
    const res = await api<Analysis>('GET', '/api/inventory/analysis', { token });
    expect(res.status).toBe(200);
    const b = res.body;

    expect(b.scope).toEqual({ category: null, warehouse: null });

    // Category breakdown sums to the grand total.
    expect(b.byCategory.reduce((s, r) => s + r.units, 0)).toBe(b.totals.units);
    // Status breakdown sums to the grand total.
    expect(b.byStatus.reduce((s, r) => s + r.units, 0)).toBe(b.totals.units);
    // Warehouse-assigned units never exceed the grand total.
    expect(b.byWarehouse.reduce((s, w) => s + w.units, 0)).toBeLessThanOrEqual(b.totals.units);

    // Control lists are populated for the dropdowns.
    expect(b.categories.length).toBeGreaterThan(0);
    expect(b.warehouses.length).toBeGreaterThan(0);

    // Sub-analysis exists for the canonical types and agrees with the category roll-up.
    for (const cat of ['RAM', 'HDD', 'SSD', 'Other']) {
      const catRow = b.byCategory.find(r => r.category === cat);
      if (!catRow) continue;
      expect(b.subtypes[cat]).toBeTruthy();
      expect(b.subtypes[cat]!.units).toBe(catRow.units);
    }
  });

  it('scopes every metric to a category filter', async () => {
    const { token } = await loginAs(ALEX);
    const full = (await api<Analysis>('GET', '/api/inventory/analysis', { token })).body;
    const cat = full.byCategory[0]!.category; // busiest category
    const catUnits = full.byCategory.find(r => r.category === cat)!.units;

    const res = await api<Analysis>('GET', `/api/inventory/analysis?category=${cat}`, { token });
    expect(res.status).toBe(200);
    const b = res.body;

    expect(b.scope.category).toBe(cat);
    // KPI total equals just that category's units.
    expect(b.totals.units).toBe(catUnits);
    // Status pipeline now reflects the slice, not the whole workspace.
    expect(b.byStatus.reduce((s, r) => s + r.units, 0)).toBe(catUnits);
    // Location table is scoped to the category but still spans warehouses.
    expect(b.byWarehouse.reduce((s, w) => s + w.units, 0)).toBeLessThanOrEqual(catUnits);
    // Only the focused subtype is detailed, and its roll-up matches.
    expect(Object.keys(b.subtypes)).toEqual([cat]);
    expect(b.subtypes[cat]!.units).toBe(catUnits);
    // Control lists stay full so the dropdowns don't lose options.
    expect(b.categories.length).toBe(full.categories.length);
    expect(b.warehouses.length).toBe(full.warehouses.length);
  });

  it('scopes the sub-analysis to a warehouse filter', async () => {
    const { token } = await loginAs(ALEX);
    const full = (await api<Analysis>('GET', '/api/inventory/analysis', { token })).body;
    // Pick the busiest warehouse from the unfiltered location table.
    const wh = [...full.byWarehouse].sort((a, b) => b.units - a.units)[0]!;

    const res = await api<Analysis>('GET', `/api/inventory/analysis?warehouse=${wh.id}`, { token });
    expect(res.status).toBe(200);
    const b = res.body;

    expect(b.scope.warehouse).toBe(wh.id);
    // KPI total equals that warehouse's unit count from the full snapshot.
    expect(b.totals.units).toBe(wh.units);
    // Composition for the warehouse sums to the warehouse total — the key bug:
    // the per-type detail must now follow the warehouse selection.
    expect(b.byCategory.reduce((s, r) => s + r.units, 0)).toBe(wh.units);
    const subUnits = Object.values(b.subtypes).reduce((s, st) => s + st.units, 0);
    expect(subUnits).toBe(wh.units);
    // …and is strictly smaller than the whole workspace (assuming >1 warehouse).
    if (full.warehouses.length > 1) {
      expect(b.totals.units).toBeLessThan(full.totals.units);
    }
  });
});

describe('GET /api/inventory/analysis and archived POs', () => {
  beforeEach(async () => { await resetDb(); });

  it('drops an archived PO out of every aggregate instead of adding an Archived bucket', async () => {
    const { token: pur } = await loginAs(MARCUS);
    const { token: mgr } = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token: pur,
      body: {
        paypalTxnId: 'TESTPAYTXN0000001',
        category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
        lines: [{ category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: 'ANLYS-ARCH-PN', condition: 'Pulled — Tested', qty: 7, unitCost: 50 }],
      },
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
    expect((await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: 'reviewing' } })).status).toBe(200);

    const before = await api<Analysis>('GET', '/api/inventory/analysis', { token: mgr });
    expect((await api('POST', `/api/orders/${id}/archive`, { token: mgr })).status).toBe(200);
    const after = await api<Analysis>('GET', '/api/inventory/analysis', { token: mgr });

    expect(after.body.totals.units).toBe(before.body.totals.units - 7);
    expect(after.body.totals.lines).toBe(before.body.totals.lines - 1);
    expect(after.body.value.cost).toBe(before.body.value.cost - 350);
    expect(after.body.byStatus.find(r => r.status === 'Archived')).toBeUndefined();
    expect(after.body.byStatus.reduce((s, r) => s + r.units, 0)).toBe(after.body.totals.units);
    const ram = (b: Analysis) => b.byCategory.find(r => r.category === 'RAM')?.units ?? 0;
    expect(ram(after.body)).toBe(ram(before.body) - 7);
    expect(after.body.subtypes.RAM?.units).toBe(ram(after.body));
  });
});
