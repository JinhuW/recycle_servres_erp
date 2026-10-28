import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { getTestDb, resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { expectSheetOrder, type SheetOrdered } from './helpers/inventory';

type Lot = { id: string; unit_cost?: number; qty: number; status: string; warehouse_id: string | null };
type Group = {
  key: string; part_number: string | null; qty: number; lot_count: number;
  po_count: number; qty_in_transit: number; qty_in_stock: number;
  unit_cost_avg?: number; unit_cost_max?: number; warehouses: string[]; lines: Lot[];
};

type PoOpts = {
  brand: string; partNumber?: string; qty?: number; unitCost?: number;
  generation?: string; rank?: string; speed?: string;
};

async function po(token: string, opts: PoOpts) {
  const r = await api<{ id: string }>('POST', '/api/orders', {
    token,
    body: {
      warehouseId: 'WH-LA1',
      paypalTxnId: 'TESTPAYTXN0000001',
      category: 'RAM',
      lines: [{
        category: 'RAM', brand: opts.brand, capacity: '32GB', type: 'DDR4',
        classification: 'RDIMM', speed: opts.speed ?? '3200',
        ...(opts.generation ? { generation: opts.generation } : {}),
        ...(opts.rank ? { rank: opts.rank } : {}),
        ...(opts.partNumber !== undefined ? { partNumber: opts.partNumber } : {}),
        // DDR5 lines must carry one serial per unit.
        ...(opts.generation === 'DDR5'
          ? { serialNumber: Array.from({ length: opts.qty ?? 4 }, () => `SN-${randomUUID().slice(0, 8)}`).join('\n') }
          : {}),
        condition: 'Pulled — Tested', qty: opts.qty ?? 4, unitCost: opts.unitCost ?? 80,
      }],
    },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
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

  it('gives each lot of a mixed-spec group its own spec, not the head\'s', async () => {
    const { token } = await loginAs(ALEX);
    await po(token, { brand: 'MIXSPECA', partNumber: 'MIXSPEC', generation: 'DDR3', rank: '2Rx4', speed: '12800' });
    await po(token, { brand: 'MIXSPECB', partNumber: 'mixspec', generation: 'DDR4', rank: '1Rx8', speed: '2666' });

    type SpecLot = Lot & { brand: string; generation: string; rank: string; speed: string };
    const r = await api<{ products: (Group & { brand: string; lines: SpecLot[] })[] }>(
      'GET', '/api/inventory/products?q=mixspec', { token });
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(1);
    const g = r.body.products[0];
    expect(g.lines.length).toBe(2);
    const specs = g.lines.map((l) => [l.brand, l.generation, l.rank, l.speed]).sort();
    expect(specs).toEqual([['MIXSPECA', 'DDR3', '2Rx4', '12800'], ['MIXSPECB', 'DDR4', '1Rx8', '2666']]);
  });

  it('groups RAM by module family: suffix variants merge, module forms stay apart', async () => {
    const { token } = await loginAs(ALEX);
    await po(token, { brand: 'Samsung', partNumber: 'M393A2K43BB1-CTD7Q', qty: 23 });
    await po(token, { brand: 'Samsung', partNumber: 'M393A2K43BB1-CTD', qty: 2 });
    await po(token, { brand: 'Samsung', partNumber: 'M391A2K43BB1-CTDQ', qty: 1 });

    const r = await api<{ products: (Group & { part_numbers: string[]; lines: (Lot & { part_number: string })[] })[] }>(
      'GET', '/api/inventory/products?q=A2K43BB1', { token });
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(2);
    const rdimm = r.body.products.find((g) => g.part_number?.startsWith('M393'))!;
    expect(rdimm.part_number).toBe('M393A2K43BB1-CTD*');
    expect(rdimm.qty).toBe(25);
    expect([...rdimm.part_numbers].sort()).toEqual(['M393A2K43BB1-CTD', 'M393A2K43BB1-CTD7Q']);
    expect(rdimm.lines.map((l) => l.part_number).sort()).toEqual(['M393A2K43BB1-CTD', 'M393A2K43BB1-CTD7Q']);
    const udimm = r.body.products.find((g) => g.part_number?.startsWith('M391'))!;
    expect(udimm.part_number).toBe('M391A2K43BB1-CTDQ');
    expect(udimm.part_numbers).toEqual(['M391A2K43BB1-CTDQ']);
  });

  it('groups DDR5 by spec: part numbers merge, a missing one joins, a spec change splits', async () => {
    const { token } = await loginAs(ALEX);
    const ddr5 = { generation: 'DDR5', rank: '2Rx4', speed: '4800' };
    await po(token, { brand: 'DDR5SPECX', partNumber: 'M321R4GA3BB6-CQK', qty: 10, ...ddr5 });
    await po(token, { brand: 'DDR5SPECX', partNumber: 'HMCG88AGBRA190N', qty: 5, ...ddr5 });
    await po(token, { brand: 'DDR5SPECX', qty: 1, ...ddr5 });
    await po(token, { brand: 'DDR5SPECX', partNumber: 'M321R4GA3BB6-CQK', qty: 2, ...ddr5, rank: '1Rx4' });
    await po(token, { brand: 'DDR5SPECX', partNumber: 'M321R4GA3BB6-CQK', qty: 3, ...ddr5, rank: '' });

    const r = await api<{ products: (Group & { part_numbers: string[]; mixed_spec: boolean; rank: string | null })[] }>(
      'GET', '/api/inventory/products?q=ddr5specx', { token });
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(3);
    const two = r.body.products.find((g) => g.rank === '2Rx4')!;
    expect(two.key.startsWith('ddr5:')).toBe(true);
    expect(two.qty).toBe(16);
    expect(two.lot_count).toBe(3);
    expect(two.part_number).toBeNull();
    expect([...two.part_numbers].sort()).toEqual(['HMCG88AGBRA190N', 'M321R4GA3BB6-CQK']);
    expect(two.mixed_spec).toBe(false);
    const one = r.body.products.find((g) => g.rank === '1Rx4')!;
    expect(one.part_number).toBe('M321R4GA3BB6-CQK');
    expect(one.qty).toBe(2);
    const blank = r.body.products.find((g) => !g.rank)!;
    expect(blank.key.startsWith('ddr5:')).toBe(true);
    expect(blank.qty).toBe(3);
  });

  it('keeps DDR4 on the part-number rule', async () => {
    const { token } = await loginAs(ALEX);
    await po(token, { brand: 'DDR4SPECX', partNumber: 'KSM32RD4/32HDR', generation: 'DDR4', rank: '2Rx4' });
    await po(token, { brand: 'DDR4SPECX', partNumber: 'KSM32RD4/32MEI', generation: 'DDR4', rank: '2Rx4' });

    const r = await products(token, 'ddr4specx');
    expect(r.status).toBe(200);
    expect(r.body.products.length).toBe(2);
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
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        warehouseId: 'WH-LA1',
        paypalTxnId: 'TESTPAYTXN0000001',
        category: 'RAM',
        lines: [{
          category: 'RAM', brand: 'STATX', capacity: '32GB', type: 'DDR4',
          classification: 'RDIMM', speed: '3200',
          partNumber: 'STAT-1', condition: 'Pulled — Tested', qty: 5, unitCost: 80,
        }],
      },
    });
    expect(created.status).toBe(201);
    // New PO lines are 'Draft'; advance Draft → In Transit (no body = next stage).
    const adv = await api('POST', `/api/orders/${created.body.id}/advance`, { token, body: {} });
    expect(adv.status).toBe(200);

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

  // The grouped table is the screen the Export button sits on, so it has to
  // read in the same sequence as the workbook it downloads.
  it('ships products in the workbook order - category, then brand, capacity, speed', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ products: SheetOrdered[] }>('GET', '/api/inventory/products', { token });
    expect(r.status).toBe(200);
    expectSheetOrder(r.body.products);
  });

  it('sorts by a column, ties in workbook order, and rejects an unknown column', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ products: (SheetOrdered & { qty: number })[] }>(
      'GET', '/api/inventory/products?sort=qty&dir=desc', { token });
    expect(r.status).toBe(200);
    const ps = r.body.products;
    for (let i = 1; i < ps.length; i++) expect(ps[i - 1].qty).toBeGreaterThanOrEqual(ps[i].qty);
    const runs = Map.groupBy(ps, (p) => p.qty);
    const tied = [...runs.values()].filter((run) => run.length > 1);
    expect(tied.length).toBeGreaterThan(0);
    for (const run of tied) expectSheetOrder(run);

    expect((await api('GET', '/api/inventory/products?sort=unit_cost', { token })).status).toBe(400);
    expect((await api('GET', '/api/inventory/products?sort=qty&dir=up', { token })).status).toBe(400);
  });

  // Purchasers' groups carry no cost, so a crafted cost sort can't rank by it.
  it('leaves a purchaser\'s list unranked under a cost sort', async () => {
    const { token } = await loginAs(MARCUS);
    const plain = await api<{ products: Group[] }>('GET', '/api/inventory/products', { token });
    const byCost = await api<{ products: Group[] }>('GET', '/api/inventory/products?sort=cost&dir=desc', { token });
    expect(byCost.status).toBe(200);
    expect(plain.body.products.length).toBeGreaterThan(1);
    expect(byCost.body.products.map((g) => g.key)).toEqual(plain.body.products.map((g) => g.key));
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

// Select-all on the desktop picks every sellable lot the filters match. The
// grouped view lists only GROUP_CAP (200) products, so the ids have to come
// from the server, and the rows for lots past the cap from POST /rows.
describe('select-all past the grouped cap', () => {
  const BRAND = 'SELALLQZ';
  const LINES = 205;

  type Row = { id: string; po_line_no: number | null; committed_qty: number };
  type Products = { products: Group[]; sellable_ids?: string[] };

  let transitId: string;
  let dallasId: string;
  let doneIds: string[];

  beforeEach(async () => {
    await resetDb();
    const { token } = await loginAs(ALEX);
    const created = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        warehouseId: 'WH-LA1',
        paypalTxnId: 'TESTPAYTXN0000001',
        category: 'RAM',
        lines: Array.from({ length: LINES }, (_, i) => ({
          category: 'RAM', brand: BRAND, capacity: '32GB', type: 'DDR4',
          classification: 'RDIMM', speed: '3200',
          partNumber: `SELALL-${String(i).padStart(3, '0')}`,
          condition: 'Pulled — Tested', qty: 2, unitCost: 50,
        })),
      },
    });
    expect(created.status).toBe(201);

    const sql = getTestDb();
    const ids = (await sql<{ id: string }[]>`
      SELECT id FROM order_lines WHERE order_id = ${created.body.id} ORDER BY position
    `).map((r) => r.id);
    expect(ids).toHaveLength(LINES);
    [transitId, dallasId] = ids;
    await sql`UPDATE order_lines SET status = 'Done' WHERE order_id = ${created.body.id}`;
    await sql`UPDATE order_lines SET status = 'In Transit' WHERE id = ${transitId}`;
    await sql`UPDATE order_lines SET warehouse_id = 'WH-DAL' WHERE id = ${dallasId}`;
    doneIds = ids.filter((id) => id !== transitId);
  });

  it('lists every matching sellable lot in sellable_ids, past the 200 listed products', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<Products>('GET', `/api/inventory/products?q=${BRAND}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.products).toHaveLength(200);

    const sellable = r.body.sellable_ids!;
    expect([...sellable].sort()).toEqual([...doneIds].sort());
    expect(sellable).not.toContain(transitId);
    const listed = new Set(r.body.products.flatMap((g) => g.lines.map((l) => l.id)));
    expect(sellable.filter((id) => !listed.has(id)).length).toBeGreaterThanOrEqual(4);
  });

  // The table sorts on the server so a column sort ranks the whole stock, not
  // just the newest 200 products the unsorted list keeps.
  it('sorts every matching product before the cap, not only the 200 listed', async () => {
    const { token } = await loginAs(ALEX);
    const unsorted = await api<Products>('GET', `/api/inventory/products?q=${BRAND}`, { token });
    const listed = new Set(unsorted.body.products.flatMap((g) => g.lines.map((l) => l.id)));
    const pastCap = doneIds.find((id) => !listed.has(id))!;
    await getTestDb()`UPDATE order_lines SET qty = 99 WHERE id = ${pastCap}`;

    const desc = await api<Products>('GET', `/api/inventory/products?q=${BRAND}&sort=qty&dir=desc`, { token });
    expect(desc.status).toBe(200);
    expect(desc.body.products).toHaveLength(200);
    expect(desc.body.products[0].qty).toBe(99);
    expect(desc.body.products[0].lines.map((l) => l.id)).toEqual([pastCap]);

    const asc = await api<Products>('GET', `/api/inventory/products?q=${BRAND}&sort=qty&dir=asc`, { token });
    expect(asc.body.products).toHaveLength(200);
    expect(asc.body.products.some((g) => g.qty === 99)).toBe(false);
  });

  it('narrows sellable_ids to the warehouse filter per lot', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<Products>(
      'GET', `/api/inventory/products?q=${BRAND}&warehouse=WH-LA1`, { token });
    expect(r.status).toBe(200);
    expect(r.body.sellable_ids).not.toContain(dallasId);
    expect(r.body.sellable_ids).toHaveLength(doneIds.length - 1);
  });

  it('lists and sums only the warehouse pill\'s lots of a product kept for one of them', async () => {
    // Two lots of one product, one moved to Dallas: under the LA1 pill the
    // product stays (its LA1 lot matches) but opens to that lot alone, and
    // its row counts that lot alone.
    const [a, b] = doneIds.slice(2, 4);
    const sql = getTestDb();
    await sql`
      UPDATE order_lines SET warehouse_id = 'WH-DAL', unit_cost = 500,
             part_number = (SELECT part_number FROM order_lines WHERE id = ${a})
       WHERE id = ${b}
    `;
    const { token } = await loginAs(ALEX);
    const all = await api<Products>('GET', `/api/inventory/products?q=${BRAND}`, { token });
    expect(all.status).toBe(200);
    const whole = all.body.products.find((g) => g.lines.some((l) => l.id === a))!;
    expect(whole.lines.map((l) => l.id).sort()).toEqual([a, b].sort());
    expect(whole.lot_count).toBe(2);
    expect(whole.warehouses.sort()).toEqual(['DAL', 'LA1']);

    const la = await api<Products>(
      'GET', `/api/inventory/products?q=${BRAND}&warehouse=WH-LA1`, { token });
    expect(la.status).toBe(200);
    const narrowed = la.body.products.find((g) => g.key === whole.key)!;
    expect(narrowed.lines.map((l) => l.id)).toEqual([a]);
    expect(narrowed.lot_count).toBe(1);
    expect(narrowed.qty).toBe(2);
    expect(narrowed.warehouses).toEqual(['LA1']);
    expect(narrowed.unit_cost_max).toBe(50);
    for (const g of la.body.products) {
      for (const l of g.lines) expect(l.warehouse_id).toBe('WH-LA1');
    }
  });

  it('holds each lot to the attribute chips, not just its group', async () => {
    // Two lots of one product (same part number), one with a brand typed
    // differently: the search still finds it, the exact brand chip does not.
    const [a, b] = doneIds.slice(2, 4);
    const sql = getTestDb();
    await sql`
      UPDATE order_lines SET brand = ${`${BRAND}-X`},
             part_number = (SELECT part_number FROM order_lines WHERE id = ${a})
       WHERE id = ${b}
    `;
    const { token } = await loginAs(ALEX);
    const r = await api<Products>(
      'GET', `/api/inventory/products?q=${BRAND}&brand=${BRAND}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.sellable_ids).toContain(a);
    expect(r.body.sellable_ids).not.toContain(b);
    expect(r.body.sellable_ids).toHaveLength(doneIds.length - 1);
  });

  it('leaves sellable_ids off a purchaser response', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api<Products>('GET', `/api/inventory/products?q=${BRAND}`, { token });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('sellable_ids');
  });

  it('returns the rows behind a selection from POST /rows', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ items: Row[] }>('POST', '/api/inventory/rows', {
      token, body: { ids: doneIds },
    });
    expect(r.status).toBe(200);
    expect(r.body.items.map((i) => i.id).sort()).toEqual([...doneIds].sort());
    for (const row of r.body.items) {
      expect(row.po_line_no).toEqual(expect.any(Number));
      expect(row.committed_qty).toBe(0);
    }
  });

  it('leaves out of POST /rows a lot sold, archived or emptied since the list loaded', async () => {
    const { token } = await loginAs(ALEX);
    const sql = getTestDb();
    const [sold, emptied, kept] = doneIds.slice(2, 5);
    await sql`UPDATE order_lines SET status = 'Sold' WHERE id = ${sold}`;
    await sql`UPDATE order_lines SET qty = 0 WHERE id = ${emptied}`;

    const other = await api<{ id: string }>('POST', '/api/orders', {
      token,
      body: {
        warehouseId: 'WH-LA1', paypalTxnId: 'TESTPAYTXN0000001', category: 'RAM',
        lines: [{
          category: 'RAM', brand: BRAND, capacity: '32GB', type: 'DDR4', classification: 'RDIMM',
          speed: '3200', partNumber: 'SELALL-ARCH', condition: 'Pulled — Tested', qty: 1, unitCost: 50,
        }],
      },
    });
    expect(other.status).toBe(201);
    const [archived] = (await sql<{ id: string }[]>`
      UPDATE order_lines SET status = 'Done' WHERE order_id = ${other.body.id} RETURNING id
    `).map((row) => row.id);
    await sql`UPDATE orders SET archived_at = NOW() WHERE id = ${other.body.id}`;

    const r = await api<{ items: Row[] }>('POST', '/api/inventory/rows', {
      token, body: { ids: [sold, emptied, archived, kept, transitId] },
    });
    expect(r.status).toBe(200);
    expect(r.body.items.map((i) => i.id)).toEqual([kept]);
  });

  it('refuses POST /rows to purchasers and rejects malformed or oversized selections', async () => {
    const buyer = await loginAs(MARCUS);
    const forbidden = await api('POST', '/api/inventory/rows', {
      token: buyer.token, body: { ids: doneIds.slice(0, 1) },
    });
    expect(forbidden.status).toBe(403);

    const { token } = await loginAs(ALEX);
    const notArray = await api('POST', '/api/inventory/rows', { token, body: { ids: doneIds[0] } });
    expect(notArray.status).toBe(400);
    const junk = await api('POST', '/api/inventory/rows', { token, body: { ids: ['not-a-uuid'] } });
    expect(junk.status).toBe(400);
    const tooMany = await api('POST', '/api/inventory/rows', {
      token, body: { ids: Array.from({ length: 5001 }, () => randomUUID()) },
    });
    expect(tooMany.status).toBe(413);
  });
});
