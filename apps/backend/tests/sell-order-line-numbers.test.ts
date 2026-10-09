// A sell order's # is one per product and stored (migration 0170). A new
// order numbers its products 1..N in the order the packing list walks them —
// warehouse tab, category, device, generation, brand… — through the whole
// file; every product added later, in any status, takes the next # after every
// other, and no # ever moves. The order page lists its lines in # order and
// every line carries its product's #, so the label on an item, the row on the
// sheet and the line on the page all read the same number. The sheet keeps
// printing a later product in its sorted row.

import { describe, it, expect, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import app from '../src/index';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { firstCustomerId } from './helpers/fixtures';
import { freezeLegacySellNumbers } from '../src/services/sellOrderNumbers';

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

// The editor's save: every line sent back in the order it was shown, each
// with the row it was, then any lines added.
function saveLines(
  mgr: string, id: string, lines: DetailLine[], edit: (l: DetailLine) => object = () => ({}),
  added: object[] = [],
) {
  return api('PATCH', `/api/sell-orders/${id}`, {
    token: mgr,
    body: {
      lines: [
        ...lines.map(l => ({
          id: l.id, inventoryId: l.inventoryId, category: l.category, label: l.label, subLabel: l.sub,
          partNumber: l.partNumber, qty: l.qty, unitPrice: l.nativeUnitPrice,
          warehouseId: l.warehouseId, condition: l.condition, ...edit(l),
        })),
        ...added,
      ],
    },
  });
}

// Adds lines to the order as the editor does, everything already on it kept.
async function addLines(mgr: string, id: string, added: object[], withIds = true) {
  const r = await saveLines(mgr, id, await detailLines(mgr, id), withIds ? () => ({}) : () => ({ id: undefined }), added);
  expect(r.status).toBe(200);
}

async function moveTo(mgr: string, id: string, to: string) {
  expect((await api('POST', `/api/sell-orders/${id}/status`, { token: mgr, body: { to } })).status).toBe(200);
}

const numbers = async (mgr: string, id: string) => (await detailLines(mgr, id)).map(l => [l.partNumber, l.no]);

type Lot = {
  pn: string; brand: string; generation?: string; warehouse: string;
  type?: string | null; category?: string; health?: number;
};

// Two seeded Reviewing POs, lower PO id first (PO ids sort numerically).
async function twoPos(): Promise<[string, string]> {
  const rows = await getTestDb()<{ id: string }[]>`
    SELECT id FROM orders WHERE lifecycle = 'reviewing' AND archived_at IS NULL ORDER BY id LIMIT 2`;
  expect(rows).toHaveLength(2);
  const [a, b] = rows.map(r => r.id).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  return [a!, b!];
}

// Fresh Reviewing lots on a PO, with the spec the sheet sorts by. `from` sets
// their position, and so their line # on the PO.
async function lotsOn(po: string, spec: Lot[], from = 600): Promise<string[]> {
  const sql = getTestDb();
  const ids: string[] = [];
  for (const [i, l] of spec.entries()) {
    const [{ id }] = await sql<{ id: string }[]>`
      INSERT INTO order_lines (order_id, category, brand, capacity, generation, type, health, qty,
                               unit_cost, sell_price, part_number, condition, status, position,
                               warehouse_id)
      VALUES (${po}, ${l.category ?? 'RAM'}, ${l.brand}, '16GB', ${l.generation ?? 'DDR4'},
              ${l.type === undefined ? 'Server' : l.type}, ${l.health ?? null}, 5, 10, 20, ${l.pn},
              'Pulled — Tested', 'Reviewing', ${from + i}, ${l.warehouse})
      RETURNING id`;
    ids.push(id);
  }
  return ids;
}

async function lots(spec: Lot[]): Promise<{ ids: string[]; po: string }> {
  const [po] = await twoPos();
  return { ids: await lotsOn(po, spec), po };
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

// The row whose `key` column reads `value`, as header → cell text, on any tab
// laid out as a header row with data rows under it.
function rowWhere(ws: ExcelJS.Worksheet, key: string, value: string): Map<string, string> | null {
  let headers: string[] = [];
  let found: Map<string, string> | null = null;
  ws.eachRow(row => {
    const cells = (row.values as unknown[]).map(v => String(v ?? ''));
    if (cells.includes(key)) {
      headers = cells;
    } else if (!found && headers.length && cells[headers.indexOf(key)] === value) {
      found = new Map(headers.map((h, i) => [h, cells[i] ?? ''] as [string, string]).filter(([h]) => h));
    }
  });
  return found;
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

  // The lot that numbers a product is chosen by PO and line #, never by where
  // a save left it: the editor writes `position` in the order it shows.
  it('a save, a price edit or a set-to-0 moves no #, even when one product\'s lots differ in type', async () => {
    const [low, high] = await twoPos();
    const [crHigh] = await lotsOn(high, [{ pn: 'NUM-CR', brand: 'Crucial', warehouse: 'WH-LA1', type: null }]);
    const [kin, sam] = await lotsOn(low, [
      { pn: 'NUM-KIN', brand: 'Kingston', warehouse: 'WH-LA1' },
      { pn: 'NUM-SAM', brand: 'Samsung', warehouse: 'WH-LA1' },
    ]);
    const [crLow] = await lotsOn(low, [{ pn: 'NUM-CR', brand: 'Crucial', warehouse: 'WH-LA1' }], 610);
    // Picked newest PO first, as the picker lists them.
    const id = await createOrder(mgr, [
      lotLine(crHigh!, 'NUM-CR', 'WH-LA1'), lotLine(kin!, 'NUM-KIN', 'WH-LA1'),
      lotLine(crLow!, 'NUM-CR', 'WH-LA1'), lotLine(sam!, 'NUM-SAM', 'WH-LA1'),
    ]);
    const numbers = async () => (await detailLines(mgr, id)).map(l => [l.partNumber, l.no]);
    // Crucial's PO-low lot is a Server module, so the product sits with the
    // servers, ahead of Kingston.
    const expected = [['NUM-CR', 1], ['NUM-CR', 1], ['NUM-KIN', 2], ['NUM-SAM', 3]];
    expect(await numbers()).toEqual(expected);

    expect((await saveLines(mgr, id, await detailLines(mgr, id))).status).toBe(200);
    expect(await numbers()).toEqual(expected);
    expect((await saveLines(mgr, id, await detailLines(mgr, id), () => ({ unitPrice: 31 }))).status).toBe(200);
    expect(await numbers()).toEqual(expected);
    expect((await saveLines(mgr, id, await detailLines(mgr, id),
      l => (l.partNumber === 'NUM-KIN' ? { qty: 0 } : {}))).status).toBe(200);
    expect(await numbers()).toEqual(expected);
    expect((await saveLines(mgr, id, await detailLines(mgr, id))).status).toBe(200);
    expect(await numbers()).toEqual(expected);

    const sheet = await workbook(mgr, `/api/sell-orders/${id}/packing-list`);
    expect(packRows(sheet.worksheets[0]!)).toEqual([['1', 'NUM-CR'], ['3', 'NUM-SAM']]);
  });

  it('shows a product\'s per-lot details from its first line above 0, not from a lot held at 0', async () => {
    const { ids } = await lots([
      { pn: 'NUM-SSD', brand: 'Intel', warehouse: 'WH-LA1', category: 'SSD', type: null, health: 61 },
      { pn: 'NUM-SSD', brand: 'Intel', warehouse: 'WH-LA1', category: 'SSD', type: null, health: 100 },
    ]);
    const ssd = (lot: string, qty: number) => ({ ...lotLine(lot, 'NUM-SSD', 'WH-LA1'), category: 'SSD', qty });
    const id = await createOrder(mgr, [ssd(ids[0]!, 1), ssd(ids[1]!, 4)]);
    expect((await saveLines(mgr, id, await detailLines(mgr, id),
      l => (l.inventoryId === ids[0] ? { qty: 0 } : {}))).status).toBe(200);

    for (const q of ['', '?groupBy=po']) {
      const row = rowWhere((await workbook(mgr, `/api/sell-orders/${id}/packing-list${q}`)).worksheets[0]!, 'Part #', 'NUM-SSD');
      expect(row?.get('Health %')).toBe('100');
      expect(row?.get('Qty')).toBe('4');
    }
    const bid = await workbook(mgr, `/api/sell-orders/${id}/price-template`);
    const bidRow = rowWhere(bid.getWorksheet('SSD')!, 'Health %', '100');
    expect(bidRow).not.toBeNull();
  });

  it('lists every by-PO tab in the plain tab\'s order, with its Type for each #', async () => {
    const [low, high] = await twoPos();
    // Tied on every spec, told apart only by part #.
    const [pHigh] = await lotsOn(high, [{ pn: 'TIE-P', brand: 'Tie', warehouse: 'WH-LA1' }]);
    const [qLow, pLow] = await lotsOn(low, [
      { pn: 'TIE-Q', brand: 'Tie', warehouse: 'WH-LA1' },
      { pn: 'TIE-P', brand: 'Tie', warehouse: 'WH-LA1' },
    ]);
    // Hynix's PO-low lot is a Server module; its PO-high lot has no type.
    const [hyLow] = await lotsOn(low, [{ pn: 'HY-9', brand: 'Hynix', warehouse: 'WH-LA1' }], 620);
    const [hyHigh, saHigh] = await lotsOn(high, [
      { pn: 'HY-9', brand: 'Hynix', warehouse: 'WH-LA1', type: null },
      { pn: 'SA-9', brand: 'Samsung', warehouse: 'WH-LA1' },
    ], 620);
    const id = await createOrder(mgr, [
      lotLine(pHigh!, 'TIE-P', 'WH-LA1'), lotLine(qLow!, 'TIE-Q', 'WH-LA1'), lotLine(pLow!, 'TIE-P', 'WH-LA1'),
      lotLine(hyHigh!, 'HY-9', 'WH-LA1'), lotLine(saHigh!, 'SA-9', 'WH-LA1'), lotLine(hyLow!, 'HY-9', 'WH-LA1'),
    ]);

    const plain = packRows((await workbook(mgr, `/api/sell-orders/${id}/packing-list`)).worksheets[0]!);
    expect(plain).toEqual([['1', 'HY-9'], ['2', 'SA-9'], ['3', 'TIE-P'], ['4', 'TIE-Q']]);
    const byPo = await workbook(mgr, `/api/sell-orders/${id}/packing-list?groupBy=po`);
    expect(byPo.worksheets.map(w => [w.name, packRows(w)])).toEqual([
      [`${low} - LA1`, [['1', 'HY-9'], ['3', 'TIE-P'], ['4', 'TIE-Q']]],
      [`${high} - LA1`, [['1', 'HY-9'], ['2', 'SA-9'], ['3', 'TIE-P']]],
    ]);
    expect(rowWhere(byPo.worksheets[1]!, 'Part #', 'HY-9')?.get('Type')).toBe('Server');
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

describe('sell order #: an added product takes the next #, in any status', () => {
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    mgr = (await loginAs(ALEX)).token;
  });

  // Kingston and Samsung DDR4 on the order; a DDR3 module, which the sheet
  // sorts ahead of both, is the one added later.
  async function packingOrder(status = 'Packing') {
    const [po] = await twoPos();
    const [k4, s4, d3] = await lotsOn(po!, [
      { pn: 'NUM-K4', brand: 'Kingston', warehouse: 'WH-LA1' },
      { pn: 'NUM-S4', brand: 'Samsung', warehouse: 'WH-LA1' },
      { pn: 'NUM-D3', brand: 'Samsung', generation: 'DDR3', warehouse: 'WH-LA1' },
    ]);
    const id = await createOrder(mgr, [lotLine(k4!, 'NUM-K4', 'WH-LA1'), lotLine(s4!, 'NUM-S4', 'WH-LA1')]);
    expect(await numbers(mgr, id)).toEqual([['NUM-K4', 1], ['NUM-S4', 2]]);
    if (status !== 'Draft') await moveTo(mgr, id, status);
    return { id, po: po!, d3: d3! };
  }

  it('on a Packing order: the page lists it last, the sheets keep it in its sorted row', async () => {
    const { id, po, d3 } = await packingOrder();
    await addLines(mgr, id, [lotLine(d3, 'NUM-D3', 'WH-LA1')]);

    expect(await numbers(mgr, id)).toEqual([['NUM-K4', 1], ['NUM-S4', 2], ['NUM-D3', 3]]);
    const plain = await workbook(mgr, `/api/sell-orders/${id}/packing-list`);
    expect(packRows(plain.worksheets[0]!)).toEqual([['3', 'NUM-D3'], ['1', 'NUM-K4'], ['2', 'NUM-S4']]);
    const byPo = await workbook(mgr, `/api/sell-orders/${id}/packing-list?groupBy=po`);
    expect(byPo.worksheets.map(w => [w.name, packRows(w)])).toEqual([
      [`${po} - LA1`, [['3', 'NUM-D3'], ['1', 'NUM-K4'], ['2', 'NUM-S4']]],
    ]);
  });

  it('on a Draft it appends too: a # never moves once given', async () => {
    const { id, d3 } = await packingOrder('Draft');
    await addLines(mgr, id, [lotLine(d3, 'NUM-D3', 'WH-LA1')]);
    expect(await numbers(mgr, id)).toEqual([['NUM-K4', 1], ['NUM-S4', 2], ['NUM-D3', 3]]);
  });

  it('a remove, a spec edit or a transfer of a lot moves no #', async () => {
    const [po] = await twoPos();
    const [k4, s4, d3] = await lotsOn(po!, [
      { pn: 'NUM-K4', brand: 'Kingston', warehouse: 'WH-LA1' },
      { pn: 'NUM-S4', brand: 'Samsung', warehouse: 'WH-LA1' },
      { pn: 'NUM-D3', brand: 'Samsung', generation: 'DDR3', warehouse: 'WH-LA1' },
    ]);
    const id = await createOrder(mgr, [
      lotLine(k4!, 'NUM-K4', 'WH-LA1'), lotLine(s4!, 'NUM-S4', 'WH-LA1'), lotLine(d3!, 'NUM-D3', 'WH-LA1'),
    ]);
    expect(await numbers(mgr, id)).toEqual([['NUM-D3', 1], ['NUM-K4', 2], ['NUM-S4', 3]]);

    // The Kingston lot comes off the order: a gap, nothing renumbered.
    const kept = (await detailLines(mgr, id)).filter(l => l.inventoryId !== k4);
    expect((await saveLines(mgr, id, kept)).status).toBe(200);
    expect(await numbers(mgr, id)).toEqual([['NUM-D3', 1], ['NUM-S4', 3]]);

    // The Samsung DDR4 lot is re-spec'd to sort first, and the DDR3 lot moves
    // to another warehouse: both keep their #.
    const sql = getTestDb();
    await sql`UPDATE order_lines SET brand = 'Adata', generation = 'DDR2' WHERE id = ${s4}`;
    await sql`UPDATE order_lines SET warehouse_id = 'WH-NJ2' WHERE id = ${d3}`;
    expect(await numbers(mgr, id)).toEqual([['NUM-D3', 1], ['NUM-S4', 3]]);
    const plain = await workbook(mgr, `/api/sell-orders/${id}/packing-list`);
    expect(plain.worksheets.map(w => [w.name, packRows(w)])).toEqual([
      ['Pack - LA1', [['3', 'NUM-S4']]],
      ['Pack - NJ2', [['1', 'NUM-D3']]],
    ]);

    // Re-added later, the Kingston lot is a new product: the next #, not its old one.
    await addLines(mgr, id, [lotLine(k4!, 'NUM-K4', 'WH-LA1')]);
    expect(await numbers(mgr, id)).toEqual([['NUM-D3', 1], ['NUM-S4', 3], ['NUM-K4', 4]]);
  });

  it('on a Shipped order it appends too', async () => {
    const { id, d3 } = await packingOrder('Shipped');
    await addLines(mgr, id, [lotLine(d3, 'NUM-D3', 'WH-LA1')]);
    expect(await numbers(mgr, id)).toEqual([['NUM-K4', 1], ['NUM-S4', 2], ['NUM-D3', 3]]);
  });

  it('a new lot of a product already on the order joins its #', async () => {
    const { id } = await packingOrder();
    const [, high] = await twoPos();
    const [k4b] = await lotsOn(high!, [{ pn: 'NUM-K4', brand: 'Kingston', warehouse: 'WH-LA1' }]);
    await addLines(mgr, id, [lotLine(k4b!, 'NUM-K4', 'WH-LA1')]);
    expect(await numbers(mgr, id)).toEqual([['NUM-K4', 1], ['NUM-K4', 1], ['NUM-S4', 2]]);
  });

  it('products added in one save are numbered in sheet order; a later save goes after them', async () => {
    const { id, po, d3 } = await packingOrder();
    const [h4, a3] = await lotsOn(po, [
      { pn: 'NUM-H4', brand: 'Hynix', warehouse: 'WH-LA1' },
      { pn: 'NUM-A3', brand: 'Adata', generation: 'DDR3', warehouse: 'WH-LA1' },
    ], 700);
    // Sent Hynix first; the sheet puts the DDR3 module first.
    await addLines(mgr, id, [lotLine(h4!, 'NUM-H4', 'WH-LA1'), lotLine(d3, 'NUM-D3', 'WH-LA1')]);
    expect(await numbers(mgr, id)).toEqual([['NUM-K4', 1], ['NUM-S4', 2], ['NUM-D3', 3], ['NUM-H4', 4]]);
    // Adata DDR3 sorts ahead of every other, but came in a later save.
    await addLines(mgr, id, [lotLine(a3!, 'NUM-A3', 'WH-LA1')]);
    expect(await numbers(mgr, id))
      .toEqual([['NUM-K4', 1], ['NUM-S4', 2], ['NUM-D3', 3], ['NUM-H4', 4], ['NUM-A3', 5]]);
  });

  it('a save without row ids keeps every lot\'s place, and a dropped-and-re-added lot too', async () => {
    const { id, d3 } = await packingOrder();
    await addLines(mgr, id, [lotLine(d3, 'NUM-D3', 'WH-LA1')]);
    const expected = [['NUM-K4', 1], ['NUM-S4', 2], ['NUM-D3', 3]];
    await addLines(mgr, id, [], false);
    expect(await numbers(mgr, id)).toEqual(expected);
    // Dropped and sent again as new, in one save.
    const lines = await detailLines(mgr, id);
    const r = await saveLines(mgr, id, lines.filter(l => l.inventoryId !== d3), () => ({}),
      [lotLine(d3, 'NUM-D3', 'WH-LA1')]);
    expect(r.status).toBe(200);
    expect(await numbers(mgr, id)).toEqual(expected);
  });

  it('a typed line keeps its place through a price or a label edit', async () => {
    const [po] = await twoPos();
    const [k4, d3] = await lotsOn(po!, [
      { pn: 'NUM-K4', brand: 'Kingston', warehouse: 'WH-LA1' },
      { pn: 'NUM-D3', brand: 'Samsung', generation: 'DDR3', warehouse: 'WH-LA1' },
    ]);
    const id = await createOrder(mgr, [lotLine(k4!, 'NUM-K4', 'WH-LA1'), typedLine('NUM-T1')]);
    await moveTo(mgr, id, 'Packing');
    await addLines(mgr, id, [lotLine(d3!, 'NUM-D3', 'WH-LA1')]);
    const expected = [['NUM-K4', 1], ['NUM-T1', 2], ['NUM-D3', 3]];
    expect(await numbers(mgr, id)).toEqual(expected);

    const typed = (l: DetailLine) => l.inventoryId === null;
    expect((await saveLines(mgr, id, await detailLines(mgr, id),
      l => (typed(l) ? { unitPrice: 11, label: 'Typed NUM-T1 (fixed)' } : {}))).status).toBe(200);
    expect(await numbers(mgr, id)).toEqual(expected);
  });

  it('across warehouse tabs it takes the next # after every tab, and moves none in another', async () => {
    const [po] = await twoPos();
    const [la, nj, d3] = await lotsOn(po!, [
      { pn: 'NUM-LA', brand: 'Kingston', warehouse: 'WH-LA1' },
      { pn: 'NUM-NJ', brand: 'Kingston', warehouse: 'WH-NJ2' },
      { pn: 'NUM-D3', brand: 'Samsung', generation: 'DDR3', warehouse: 'WH-LA1' },
    ]);
    const id = await createOrder(mgr, [lotLine(la!, 'NUM-LA', 'WH-LA1'), lotLine(nj!, 'NUM-NJ', 'WH-NJ2')]);
    await moveTo(mgr, id, 'Packing');
    await addLines(mgr, id, [lotLine(d3!, 'NUM-D3', 'WH-LA1')]);

    expect(await numbers(mgr, id)).toEqual([['NUM-LA', 1], ['NUM-NJ', 2], ['NUM-D3', 3]]);
    const plain = await workbook(mgr, `/api/sell-orders/${id}/packing-list`);
    expect(plain.worksheets.map(w => [w.name, packRows(w)])).toEqual([
      ['Pack - LA1', [['3', 'NUM-D3'], ['1', 'NUM-LA']]],
      ['Pack - NJ2', [['2', 'NUM-NJ']]],
    ]);
  });
});

// Orders that existed before 0170 showed a # derived on every read; the boot
// freezes exactly that number — sorted set first, then each append batch — so
// no label already written moves.
describe('sell order #: the boot freezes the numbers older orders showed', () => {
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    mgr = (await loginAs(ALEX)).token;
  });

  it('numbers the sorted set by the packing list, then each append batch after it, tabs and 0s included', async () => {
    const [po] = await twoPos();
    const [k4, s4, d3, h4, a3, nj, zero] = await lotsOn(po!, [
      { pn: 'FRZ-K4', brand: 'Kingston', warehouse: 'WH-LA1' },
      { pn: 'FRZ-S4', brand: 'Samsung', warehouse: 'WH-LA1' },
      { pn: 'FRZ-D3', brand: 'Samsung', generation: 'DDR3', warehouse: 'WH-LA1' },
      { pn: 'FRZ-H4', brand: 'Hynix', warehouse: 'WH-LA1' },
      { pn: 'FRZ-A3', brand: 'Adata', generation: 'DDR3', warehouse: 'WH-LA1' },
      { pn: 'FRZ-NJ', brand: 'Kingston', warehouse: 'WH-NJ2' },
      { pn: 'FRZ-Z0', brand: 'Crucial', warehouse: 'WH-LA1' },
    ]);
    const id = await createOrder(mgr, [
      lotLine(k4!, 'FRZ-K4', 'WH-LA1'), lotLine(s4!, 'FRZ-S4', 'WH-LA1'), lotLine(nj!, 'FRZ-NJ', 'WH-NJ2'),
      lotLine(zero!, 'FRZ-Z0', 'WH-LA1'), lotLine(d3!, 'FRZ-D3', 'WH-LA1'), lotLine(h4!, 'FRZ-H4', 'WH-LA1'),
      lotLine(a3!, 'FRZ-A3', 'WH-LA1'),
    ]);
    // As the order stood before 0170: nothing stored; K4, S4, NJ and a line
    // held at 0 in the sorted set, D3 and H4 added by the first save past
    // Draft, A3 by the second.
    const sql = getTestDb();
    await sql`UPDATE sell_order_lines SET qty = 0 WHERE sell_order_id = ${id} AND inventory_id = ${zero}`;
    await sql`UPDATE sell_order_lines SET product_no = NULL, append_batch = CASE
                WHEN inventory_id IN (${d3}, ${h4}) THEN 1
                WHEN inventory_id = ${a3} THEN 2 END
              WHERE sell_order_id = ${id}`;
    await sql`UPDATE sell_orders SET next_product_no = 1 WHERE id = ${id}`;

    expect(await freezeLegacySellNumbers(sql)).toBeGreaterThanOrEqual(1);
    // The sorted set walks LA1 (Crucial, Kingston, Samsung) then NJ2; batch 1
    // in sheet order (DDR3 before DDR4); batch 2 last.
    expect(await numbers(mgr, id)).toEqual([
      ['FRZ-Z0', 1], ['FRZ-K4', 2], ['FRZ-S4', 3], ['FRZ-NJ', 4], ['FRZ-D3', 5], ['FRZ-H4', 6], ['FRZ-A3', 7],
    ]);
    // The counter picks up after them, and a second boot changes nothing.
    await addLines(mgr, id, [typedLine('FRZ-T1')]);
    expect((await numbers(mgr, id)).at(-1)).toEqual(['FRZ-T1', 8]);
    expect(await freezeLegacySellNumbers(sql)).toBe(0);
  });

  it('numbers a line an older instance wrote unnumbered into a numbered order, as a save would', async () => {
    const [po] = await twoPos();
    const [k4, s4] = await lotsOn(po!, [
      { pn: 'FRZ-K4', brand: 'Kingston', warehouse: 'WH-LA1' },
      { pn: 'FRZ-S4', brand: 'Samsung', warehouse: 'WH-LA1' },
    ]);
    const id = await createOrder(mgr, [lotLine(k4!, 'FRZ-K4', 'WH-LA1')]);
    const sql = getTestDb();
    await sql`INSERT INTO sell_order_lines (sell_order_id, inventory_id, category, label, part_number, qty, unit_price, warehouse_id)
              VALUES (${id}, ${s4}, 'RAM', 'FRZ-S4', 'FRZ-S4', 1, 30, 'WH-LA1')`;
    // Shown already as the # it will be stored with.
    expect(await numbers(mgr, id)).toEqual([['FRZ-K4', 1], ['FRZ-S4', 2]]);
    await freezeLegacySellNumbers(sql);
    expect(await numbers(mgr, id)).toEqual([['FRZ-K4', 1], ['FRZ-S4', 2]]);
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM sell_order_lines WHERE sell_order_id = ${id} AND product_no IS NULL`;
    expect(n).toBe(0);
  });
});

describe('sell order #: what a deploy, a re-spec and a typed line can do', () => {
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    mgr = (await loginAs(ALEX)).token;
  });

  async function packingOrder() {
    const [po] = await twoPos();
    const [k4, s4, d3] = await lotsOn(po!, [
      { pn: 'REV-K4', brand: 'Kingston', warehouse: 'WH-LA1' },
      { pn: 'REV-S4', brand: 'Samsung', warehouse: 'WH-LA1' },
      { pn: 'REV-D3', brand: 'Samsung', generation: 'DDR3', warehouse: 'WH-LA1' },
    ]);
    const id = await createOrder(mgr, [lotLine(k4!, 'REV-K4', 'WH-LA1'), lotLine(s4!, 'REV-S4', 'WH-LA1')]);
    await moveTo(mgr, id, 'Packing');
    await addLines(mgr, id, [lotLine(d3!, 'REV-D3', 'WH-LA1')]);
    return { id, po: po!, k4: k4!, s4: s4!, d3: d3! };
  }

  it('an order the previous release rewrote mid-deploy shows, and keeps on its next save, the #s that release showed', async () => {
    const { id } = await packingOrder();
    const expected = [['REV-K4', 1], ['REV-S4', 2], ['REV-D3', 3]];
    expect(await numbers(mgr, id)).toEqual(expected);
    const sql = getTestDb();
    // Still written, so the previous release numbers the added DDR3 module last too.
    const batches = await sql<{ part_number: string; append_batch: number | null }[]>`
      SELECT part_number, append_batch FROM sell_order_lines WHERE sell_order_id = ${id} ORDER BY part_number`;
    expect(batches.map(b => [b.part_number, b.append_batch])).toEqual([['REV-D3', 1], ['REV-K4', null], ['REV-S4', null]]);

    // The old instance's save: every line re-inserted with no #.
    await sql`UPDATE sell_order_lines SET product_no = NULL WHERE sell_order_id = ${id}`;
    expect(await numbers(mgr, id)).toEqual(expected);
    // The new instance's next save stores those, not the counter's next three.
    await addLines(mgr, id, []);
    expect(await numbers(mgr, id)).toEqual(expected);
    const stored = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM sell_order_lines WHERE sell_order_id = ${id} AND product_no IS NULL`;
    expect(stored[0]!.n).toBe(0);
  });

  it('a lot re-spec\'d keeps its product\'s #, and the sheet prints it as a row of its own', async () => {
    const [po, other] = await twoPos();
    const [a] = await lotsOn(po!, [{ pn: 'REV-TW', brand: 'Kingston', warehouse: 'WH-LA1' }]);
    const [b] = await lotsOn(other!, [{ pn: 'REV-TW', brand: 'Kingston', warehouse: 'WH-LA1' }]);
    const id = await createOrder(mgr, [lotLine(a!, 'REV-TW', 'WH-LA1'), lotLine(b!, 'REV-TW', 'WH-LA1')]);
    expect(await numbers(mgr, id)).toEqual([['REV-TW', 1], ['REV-TW', 1]]);

    await getTestDb()`UPDATE order_lines SET part_number = 'REV-TX' WHERE id = ${b}`;
    const plain = await workbook(mgr, `/api/sell-orders/${id}/packing-list`);
    expect(packRows(plain.worksheets[0]!).sort()).toEqual([['1', 'REV-TW'], ['1', 'REV-TX']]);
    // On the page and in Pack mode it is still product #1, whose labels it carries.
    expect((await detailLines(mgr, id)).map(l => l.no)).toEqual([1, 1]);
  });

  it('a typed line joins a product\'s # only in its own warehouse', async () => {
    const id = await createOrder(mgr, [typedLine('REV-T1', 'WH-LA1')]);
    await addLines(mgr, id, [typedLine('REV-T1', 'WH-NJ2')], false);
    expect((await numbers(mgr, id)).sort()).toEqual([['REV-T1', 1], ['REV-T1', 2]]);
  });
});
