// A sell order's # is one per product, counted 1..N in the order the packing
// list walks them — warehouse tab, category, device, generation, brand… —
// through the whole file. The order page lists its lines the same way and
// every line carries its product's #, so the label on an item, the row on the
// sheet and the line on the page all read the same number.

import { describe, it, expect, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import app from '../src/index';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { firstCustomerId } from './helpers/fixtures';

type DetailLine = {
  id: string; no: number; inventoryId: string | null; category: string; label: string; sub: string | null;
  partNumber: string | null; qty: number; nativeUnitPrice: number; warehouseId: string | null;
  condition: string | null;
};

async function detailLines(mgr: string, id: string): Promise<DetailLine[]> {
  const r = await api<{ order: { lines: DetailLine[] } }>('GET', `/api/sell-orders/${id}`, { token: mgr });
  expect(r.status).toBe(200);
  return r.body.order.lines;
}

async function createOrder(mgr: string, lines: object[]): Promise<string> {
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token: mgr, body: { customerId: await firstCustomerId(mgr), lines },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

// The editor's save: every line sent back in the order it was shown.
function saveLines(mgr: string, id: string, lines: DetailLine[], edit: (l: DetailLine) => object = () => ({})) {
  return api('PATCH', `/api/sell-orders/${id}`, {
    token: mgr,
    body: {
      lines: lines.map(l => ({
        inventoryId: l.inventoryId, category: l.category, label: l.label, subLabel: l.sub,
        partNumber: l.partNumber, qty: l.qty, unitPrice: l.nativeUnitPrice,
        warehouseId: l.warehouseId, condition: l.condition, ...edit(l),
      })),
    },
  });
}

type Lot = { pn: string; brand: string; generation: string; warehouse: string };

// Fresh Reviewing RAM lots on a seeded PO, with the spec the sheet sorts by.
async function lots(spec: Lot[]): Promise<{ ids: string[]; po: string }> {
  const sql = getTestDb();
  const [{ id: po }] = await sql<{ id: string }[]>`
    SELECT id FROM orders WHERE lifecycle = 'reviewing' AND archived_at IS NULL ORDER BY id LIMIT 1`;
  const ids: string[] = [];
  for (const [i, l] of spec.entries()) {
    const [{ id }] = await sql<{ id: string }[]>`
      INSERT INTO order_lines (order_id, category, brand, capacity, generation, type, qty, unit_cost,
                               sell_price, part_number, condition, status, position, warehouse_id)
      VALUES (${po}, 'RAM', ${l.brand}, '16GB', ${l.generation}, 'Server', 5, 10, 20, ${l.pn},
              'Pulled — Tested', 'Reviewing', ${600 + i}, ${l.warehouse})
      RETURNING id`;
    ids.push(id);
  }
  return { ids, po };
}

const lotLine = (id: string, pn: string, warehouse: string) => ({
  inventoryId: id, category: 'RAM', label: pn, partNumber: pn, qty: 1, unitPrice: 30,
  warehouseId: warehouse, condition: 'Pulled — Tested',
});
const typedLine = (pn: string, warehouse = 'WH-LA1') => ({
  category: 'SSD', label: 'Typed ' + pn, partNumber: pn, qty: 1, unitPrice: 10, warehouseId: warehouse,
});

function getRaw(path: string, token: string): Promise<Response> {
  return app.fetch(new Request('http://test' + path, {
    headers: { cookie: `at=${token}`, 'X-Requested-By': 'recycle-erp' },
  }), testEnv);
}

async function workbook(token: string, path: string): Promise<ExcelJS.Workbook> {
  const res = await getRaw(path, token);
  expect(res.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb;
}

// Each data row's (#, Part #) on a packing tab, every section, in sheet order.
function packRows(ws: ExcelJS.Worksheet): [string, string][] {
  const out: [string, string][] = [];
  let noCol = 0;
  let partCol = 0;
  ws.eachRow(row => {
    const cells = (row.values as unknown[]).map(v => String(v ?? ''));
    if (cells.includes('Packed ✓')) {
      noCol = cells.indexOf('#');
      partCol = cells.indexOf('Part #');
    } else if (cells.includes('Subtotal')) {
      noCol = 0;
    } else if (noCol) {
      out.push([String(row.getCell(noCol).value ?? ''), String(row.getCell(partCol).value ?? '')]);
    }
  });
  return out;
}

describe('sell order #: one per product, in packing-list order', () => {
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    mgr = (await loginAs(ALEX)).token;
  });

  it('lists the order the way the packing list does, and numbers both the same', async () => {
    const { ids } = await lots([
      { pn: 'NUM-D4', brand: 'Kingston', generation: 'DDR4', warehouse: 'WH-LA1' },
      { pn: 'NUM-D3', brand: 'Samsung', generation: 'DDR3', warehouse: 'WH-LA1' },
    ]);
    // Added DDR4 first; the sheet puts DDR3 first, and so does the order.
    const id = await createOrder(mgr, [lotLine(ids[0]!, 'NUM-D4', 'WH-LA1'), lotLine(ids[1]!, 'NUM-D3', 'WH-LA1')]);

    const lines = await detailLines(mgr, id);
    expect(lines.map(l => [l.partNumber, l.no])).toEqual([['NUM-D3', 1], ['NUM-D4', 2]]);
    const sheet = await workbook(mgr, `/api/sell-orders/${id}/packing-list`);
    expect(packRows(sheet.worksheets[0]!)).toEqual([['1', 'NUM-D3'], ['2', 'NUM-D4']]);
  });

  it('counts on through every warehouse tab, and every file shows the same #', async () => {
    const { ids, po } = await lots([
      { pn: 'NUM-NJ', brand: 'Kingston', generation: 'DDR4', warehouse: 'WH-NJ2' },
      { pn: 'NUM-LA', brand: 'Kingston', generation: 'DDR4', warehouse: 'WH-LA1' },
    ]);
    const id = await createOrder(mgr, [lotLine(ids[0]!, 'NUM-NJ', 'WH-NJ2'), lotLine(ids[1]!, 'NUM-LA', 'WH-LA1')]);

    // LA1's tab comes first, so its product is #1 and NJ2's goes on at #2.
    expect((await detailLines(mgr, id)).map(l => [l.partNumber, l.no])).toEqual([['NUM-LA', 1], ['NUM-NJ', 2]]);
    const plain = await workbook(mgr, `/api/sell-orders/${id}/packing-list`);
    expect(plain.worksheets.map(w => [w.name, packRows(w)])).toEqual([
      ['Pack - LA1', [['1', 'NUM-LA']]],
      ['Pack - NJ2', [['2', 'NUM-NJ']]],
    ]);
    const nj = await workbook(mgr, `/api/sell-orders/${id}/packing-list?warehouse=NJ2`);
    expect(nj.worksheets.map(w => packRows(w))).toEqual([[['2', 'NUM-NJ']]]);
    const byPo = await workbook(mgr, `/api/sell-orders/${id}/packing-list?groupBy=po`);
    expect(byPo.worksheets.map(w => [w.name, packRows(w)])).toEqual([
      [`${po} - LA1`, [['1', 'NUM-LA']]],
      [`${po} - NJ2`, [['2', 'NUM-NJ']]],
    ]);
  });

  it('saving the order as shown moves no # and records nothing', async () => {
    const { ids } = await lots([
      { pn: 'NUM-D4', brand: 'Kingston', generation: 'DDR4', warehouse: 'WH-LA1' },
      { pn: 'NUM-D3', brand: 'Samsung', generation: 'DDR3', warehouse: 'WH-LA1' },
    ]);
    const id = await createOrder(mgr, [
      lotLine(ids[0]!, 'NUM-D4', 'WH-LA1'), typedLine('NUM-T1'), lotLine(ids[1]!, 'NUM-D3', 'WH-LA1'),
    ]);
    const before = await detailLines(mgr, id);
    const sql = getTestDb();
    const events = async () => (await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM sell_order_events WHERE sell_order_id = ${id}`)[0]!.n;
    const logged = await events();

    expect((await saveLines(mgr, id, before)).status).toBe(200);
    const after = await detailLines(mgr, id);
    expect(after.map(l => [l.partNumber, l.no])).toEqual(before.map(l => [l.partNumber, l.no]));
    expect(await events()).toBe(logged);
  });

  it('gives no tab to a warehouse left with only 0 lines, and refuses a list with nothing above 0', async () => {
    const id = await createOrder(mgr, [typedLine('NUM-LA'), typedLine('NUM-NJ', 'WH-NJ2')]);
    expect((await saveLines(mgr, id, await detailLines(mgr, id),
      l => (l.partNumber === 'NUM-NJ' ? { qty: 0 } : {}))).status).toBe(200);

    expect((await workbook(mgr, `/api/sell-orders/${id}/packing-list`)).worksheets.map(w => w.name))
      .toEqual(['Pack - LA1']);
    expect((await workbook(mgr, `/api/sell-orders/${id}/packing-list?groupBy=po`)).worksheets.map(w => w.name))
      .toEqual(['No PO - LA1']);
    expect((await getRaw(`/api/sell-orders/${id}/packing-list?warehouse=NJ2`, mgr)).status).toBe(400);

    expect((await saveLines(mgr, id, await detailLines(mgr, id), () => ({ qty: 0 }))).status).toBe(200);
    for (const q of ['', '?groupBy=po', '?warehouse=LA1']) {
      expect((await getRaw(`/api/sell-orders/${id}/packing-list${q}`, mgr)).status).toBe(400);
    }
  });
});
