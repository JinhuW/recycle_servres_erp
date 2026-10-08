// A sell-order line can't ship is set to 0 rather than removed: removing a
// line renumbers every line after it, and the packer labels items by that #.
// A 0 line holds nothing, sells nothing and prices nothing.

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import app from '../src/index';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart, testEnv } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { firstCustomerId } from './helpers/fixtures';

type DetailLine = {
  id: string; no: number; inventoryId: string | null; category: string; label: string; sub: string | null;
  partNumber: string | null; qty: number; nativeUnitPrice: number; unitPrice: number;
  warehouseId: string | null; condition: string | null; position: number;
};

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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

// The editor's save: every line sent back in order, with `edit` applied.
function patchLines(mgr: string, id: string, lines: DetailLine[],
  edit: (l: DetailLine) => Partial<{ qty: number; unitPrice: number }> = () => ({})) {
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

const setStatus = (mgr: string, id: string, to: string, extra: object = {}) =>
  api('POST', `/api/sell-orders/${id}/status`, { token: mgr, body: { to, ...extra } });

// Fresh Reviewing lots on a seeded PO, so no earlier sale of them muddies
// what a sale of them does.
async function freshLots(n: number): Promise<{ ids: string[]; po: string }> {
  const sql = getTestDb();
  const [{ id: po }] = await sql<{ id: string }[]>`
    SELECT id FROM orders WHERE lifecycle = 'reviewing' AND archived_at IS NULL ORDER BY id LIMIT 1`;
  const ids = (await sql<{ id: string }[]>`
    INSERT INTO order_lines (order_id, category, qty, unit_cost, sell_price, part_number,
                             condition, status, position, warehouse_id)
    SELECT ${po}, 'RAM', 5, 10, 20, 'ZQ-LOT-' || g, 'Pulled — Tested', 'Reviewing', 500 + g, 'WH-LA1'
    FROM generate_series(1, ${n}) g
    RETURNING id`).map(r => r.id);
  return { ids, po };
}

const lotLine = (id: string, n: number, qty = 1) => ({
  inventoryId: id, category: 'RAM', label: 'Lot ' + n, partNumber: 'ZQ-LOT-' + n,
  qty, unitPrice: 30, warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
});
const typedLine = (pn: string, qty = 1, unitPrice = 10) => ({
  category: 'SSD', label: 'Typed ' + pn, partNumber: pn, qty, unitPrice, warehouseId: 'WH-LA1',
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

// Each data row's (#, Part #) on a packing tab, every section.
function packRows(ws: ExcelJS.Worksheet): { no: string; part: string }[] {
  const out: { no: string; part: string }[] = [];
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
      out.push({ no: String(row.getCell(noCol).value ?? ''), part: String(row.getCell(partCol).value ?? '') });
    }
  });
  return out;
}

describe('sell order lines at qty 0', () => {
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    mgr = (await loginAs(ALEX)).token;
  });

  it('an existing line goes to 0 and keeps its place', async () => {
    const { ids } = await freshLots(2);
    const id = await createOrder(mgr, [lotLine(ids[0]!, 1), lotLine(ids[1]!, 2), typedLine('ZQ-T1', 3)]);
    const before = await detailLines(mgr, id);

    const r = await patchLines(mgr, id, before, l => (l.inventoryId === ids[1] ? {} : { qty: 0 }));
    expect(r.status).toBe(200);
    const after = await detailLines(mgr, id);
    expect(after.map(l => l.partNumber)).toEqual(before.map(l => l.partNumber));
    expect(after.map(l => l.qty)).toEqual([0, 1, 0]);
  });

  it('holds a line whose lot is gone at 0, but not above', async () => {
    const { ids } = await freshLots(1);
    const id = await createOrder(mgr, [lotLine(ids[0]!, 1), typedLine('ZQ-T1')]);
    await getTestDb()`UPDATE order_lines SET status = 'Sold' WHERE id = ${ids[0]!}`;
    const lines = await detailLines(mgr, id);

    expect((await patchLines(mgr, id, lines)).status).toBe(400);
    expect((await patchLines(mgr, id, lines, l => (l.inventoryId ? { qty: 0 } : {}))).status).toBe(200);
  });

  it('holds at 0 only a lot already on the order', async () => {
    const { ids } = await freshLots(2);
    const id = await createOrder(mgr, [lotLine(ids[0]!, 1)]);
    const saved = (await detailLines(mgr, id)).map(l => ({
      inventoryId: l.inventoryId, category: l.category, label: l.label, partNumber: l.partNumber,
      qty: l.qty, unitPrice: l.nativeUnitPrice, warehouseId: l.warehouseId, condition: l.condition,
    }));
    const save = (lines: object[]) => api<{ error: string }>('PATCH', `/api/sell-orders/${id}`, {
      token: mgr, body: { lines },
    });

    // A lot new to the order, and an id no lot has: a 400, never the FK's 500.
    const fresh = await save([...saved, { ...lotLine(ids[1]!, 2), qty: 0 }]);
    expect(fresh.status).toBe(400);
    expect(fresh.body.error).toMatch(/at least 1/);
    expect((await save([...saved, { ...lotLine(ids[1]!, 2), inventoryId: randomUUID(), qty: 0 }])).status).toBe(400);

    // The lot already on the order, however its id is spelt.
    expect((await save([{ ...saved[0]!, inventoryId: ids[0]!.toUpperCase(), qty: 0 }])).status).toBe(200);
  });

  it('refuses both packing lists for an order with nothing above 0', async () => {
    const id = await createOrder(mgr, [typedLine('ZQ-T1'), typedLine('ZQ-T2')]);
    expect((await patchLines(mgr, id, await detailLines(mgr, id), () => ({ qty: 0 }))).status).toBe(200);
    for (const q of ['', '?groupBy=po']) {
      const r = await api<{ error: string }>('GET', `/api/sell-orders/${id}/packing-list${q}`, { token: mgr });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/nothing to pack/);
    }
  });

  it('an order with nothing on it cannot ship, wait for payment or be done', async () => {
    const id = await createOrder(mgr, [typedLine('ZQ-T1', 2)]);
    expect((await patchLines(mgr, id, await detailLines(mgr, id), () => ({ qty: 0 }))).status).toBe(200);
    for (const to of ['Shipped', 'Awaiting payment', 'Done']) {
      expect((await setStatus(mgr, id, to)).status).toBe(409);
    }
    expect((await setStatus(mgr, id, 'Closed', { closeReasonId: 'customer_cancelled' })).status).toBe(200);
  });

  it('a shipped order zeroed afterwards cannot be marked done', async () => {
    const id = await createOrder(mgr, [typedLine('ZQ-T1', 2)]);
    expect((await setStatus(mgr, id, 'Shipped')).status).toBe(200);
    expect((await patchLines(mgr, id, await detailLines(mgr, id), () => ({ qty: 0 }))).status).toBe(200);
    expect((await setStatus(mgr, id, 'Done')).status).toBe(409);
  });

  it('Done sells nothing of a lot held at 0, records no market price for it, and its PO page still loads', async () => {
    const sql = getTestDb();
    const { ids, po } = await freshLots(2);
    const id = await createOrder(mgr, [lotLine(ids[0]!, 1), lotLine(ids[1]!, 2, 2)]);
    await patchLines(mgr, id, await detailLines(mgr, id), l => (l.inventoryId === ids[0] ? { qty: 0 } : {}));
    expect((await setStatus(mgr, id, 'Done')).status).toBe(200);

    const lots = await sql<{ id: string; qty: number; status: string }[]>`
      SELECT id, qty, status FROM order_lines WHERE id IN ${sql(ids)}`;
    expect(lots.find(l => l.id === ids[0])).toMatchObject({ qty: 5, status: 'Reviewing' });
    expect(lots.find(l => l.id === ids[1])).toMatchObject({ qty: 3 });
    const sold = await sql<{ order_line_id: string }[]>`
      SELECT order_line_id FROM inventory_events WHERE kind = 'sold' AND detail->>'sellOrder' = ${id}`;
    expect(sold.map(e => e.order_line_id)).toEqual([ids[1]]);

    const nan = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ref_price_events WHERE price = 'NaN'::numeric`;
    expect(nan[0]!.n).toBe(0);
    const recorded = await sql<{ part_number: string }[]>`
      SELECT rp.part_number FROM ref_price_events e JOIN ref_prices rp ON rp.id = e.ref_price_id
      WHERE e.source = ${'sale:' + id}`;
    expect(recorded.map(r => r.part_number)).toEqual(['ZQ-LOT-2']);

    const page = await api<{ order: { lines: { id: string; finalSellPrice?: number | null }[] } }>(
      'GET', `/api/orders/${po}`, { token: mgr });
    expect(page.status).toBe(200);
    expect(page.body.order.lines.find(l => l.id === ids[0])?.finalSellPrice ?? null).toBeNull();
  });

  it('a negotiated total leaves a 0 line priced as it was', async () => {
    const id = await createOrder(mgr, [typedLine('ZQ-T1', 3, 10), typedLine('ZQ-T2', 1, 5)]);
    await patchLines(mgr, id, await detailLines(mgr, id), l => (l.partNumber === 'ZQ-T2' ? { qty: 0 } : {}));
    const r = await api('POST', `/api/sell-orders/${id}/adjust-price`, { token: mgr, body: { targetTotal: 25 } });
    expect(r.status).toBe(200);
    const after = await detailLines(mgr, id);
    expect(after.find(l => l.partNumber === 'ZQ-T2')!.unitPrice).toBe(5);
    const live = after.find(l => l.partNumber === 'ZQ-T1')!;
    expect(+(live.unitPrice * live.qty).toFixed(2)).toBeCloseTo(25, 1);
  });

  it('numbers products the same way on the order and the packing list, tied positions included', async () => {
    const id = await createOrder(mgr, [typedLine('ZQ-T1'), typedLine('ZQ-T2'), typedLine('ZQ-T3')]);
    await getTestDb()`UPDATE sell_order_lines SET position = 0 WHERE sell_order_id = ${id}`;
    const noOf = new Map((await detailLines(mgr, id)).map(l => [l.partNumber, l.no]));

    const wb = await workbook(mgr, `/api/sell-orders/${id}/packing-list`);
    const rows = packRows(wb.worksheets[0]!);
    for (const r of rows) expect(r.no).toBe(String(noOf.get(r.part)));
    expect(rows).toHaveLength(3);
  });

  it('leaves a 0 line off every sheet while it keeps its #', async () => {
    const id = await createOrder(mgr, [typedLine('ZQ-T1'), typedLine('ZQ-T2'), typedLine('ZQ-T3')]);
    await patchLines(mgr, id, await detailLines(mgr, id), l => (l.partNumber === 'ZQ-T2' ? { qty: 0 } : {}));

    for (const q of ['', '?groupBy=po']) {
      const rows = packRows((await workbook(mgr, `/api/sell-orders/${id}/packing-list${q}`)).worksheets[0]!);
      expect(rows.map(r => [r.no, r.part]).sort()).toEqual([['1', 'ZQ-T1'], ['3', 'ZQ-T3']]);
    }
    const bid = await workbook(mgr, `/api/sell-orders/${id}/price-template`);
    const bidCells: string[] = [];
    bid.eachSheet(ws => ws.eachRow(row => row.eachCell(c => { bidCells.push(String(c.value ?? '')); })));
    expect(bidCells).toContain('ZQ-T1');
    expect(bidCells).not.toContain('ZQ-T2');

    // The returned bid sheet can't price a line the sheet never offered, so
    // the import doesn't report it as missing either.
    const sheet = await getRaw(`/api/sell-orders/${id}/price-template`, mgr);
    const file = new Blob([await sheet.arrayBuffer()], { type: XLSX_MIME });
    const preview = await multipart(`/api/sell-orders/${id}/price-import/preview`, { file }, { token: mgr });
    expect(preview.status).toBe(200);
    const unmatched = (preview.body as { unmatchedProducts: { partNumber: string | null }[] }).unmatchedProducts;
    expect(unmatched.map(p => p.partNumber)).not.toContain('ZQ-T2');
  });
});
