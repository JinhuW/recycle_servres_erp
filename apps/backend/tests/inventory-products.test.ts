import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

type Lot = { id: string; unit_cost?: number; qty: number; status: string };
type Group = {
  key: string; part_number: string | null; qty: number; lot_count: number;
  po_count: number; qty_in_transit: number; qty_in_stock: number;
  unit_cost_avg?: number; lines: Lot[];
};

async function po(token: string, opts: { brand: string; partNumber?: string; qty?: number; unitCost?: number }) {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      category: 'RAM',
      lines: [{
        category: 'RAM', brand: opts.brand, capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: '3200',
        ...(opts.partNumber !== undefined ? { partNumber: opts.partNumber } : {}),
        condition: 'Pulled — Tested', qty: opts.qty ?? 4, unitCost: opts.unitCost ?? 80,
      }],
    },
  });
  expect(r.status).toBe(201);
}

async function products(token: string, q: string) {
  return api<{ products: Group[] }>('GET', `/api/inventory/products?q=${encodeURIComponent(q)}`, { token });
}

describe('GET /api/inventory/products', () => {
  beforeEach(async () => { await resetDb(); });

  it('groups sloppy part-number variants into ONE product, summing qty & lots', async () => {
    const { token } = await loginAs(ALEX);
    await po(token, { brand: 'GRPTESTA', partNumber: 'GRPA-1', qty: 4, unitCost: 70 });
    await po(token, { brand: 'GRPTESTA', partNumber: ' grpa-1 ', qty: 6, unitCost: 90 });
    await po(token, { brand: 'GRPTESTA', partNumber: 'PN: GRPA-1', qty: 1, unitCost: 80 });

    const r = await products(token, 'grpa-1');
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(1);
    const g = r.body.products[0];
    expect(g.qty).toBe(11);
    expect(g.lot_count).toBe(3);
    expect(g.po_count).toBe(3);
    expect(g.lines.length).toBe(3);
    expect(g.unit_cost_avg).toBeCloseTo((4 * 70 + 6 * 90 + 1 * 80) / 11, 4);
  });

  it('treats part-number-less lines as their own singleton groups', async () => {
    const { token } = await loginAs(ALEX);
    await po(token, { brand: 'NULLBRANDX' });
    await po(token, { brand: 'NULLBRANDX' });

    const r = await products(token, 'nullbrandx');
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(2);
    for (const g of r.body.products) {
      expect(g.part_number).toBeNull();
      expect(g.key.startsWith('line:')).toBe(true);
      expect(g.lot_count).toBe(1);
    }
  });

  it('aggregates qty by status', async () => {
    const { token } = await loginAs(ALEX);
    await po(token, { brand: 'STATX', partNumber: 'STAT-1', qty: 5 });
    const r = await products(token, 'stat-1');
    const g = r.body.products[0];
    expect(g.qty_in_transit).toBe(5);
    expect(g.qty_in_stock).toBe(0);
  });

  it('hides cost from purchasers (no unit_cost on lots, no unit_cost_avg)', async () => {
    const { token } = await loginAs(MARCUS);
    await po(token, { brand: 'PURCOSTX', partNumber: 'PUR-1' });
    const r = await products(token, 'pur-1');
    expect(r.status).toBe(200);
    const g = r.body.products[0];
    expect(g.unit_cost_avg).toBeUndefined();
    expect(g.lines[0].unit_cost).toBeUndefined();
  });

  it('scopes purchasers to their own lines', async () => {
    const mgr = await loginAs(ALEX);
    await po(mgr.token, { brand: 'SCOPEZ', partNumber: 'SCOPE-9' });
    const buyer = await loginAs(MARCUS);
    const r = await products(buyer.token, 'scope-9');
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(0);
  });
});
