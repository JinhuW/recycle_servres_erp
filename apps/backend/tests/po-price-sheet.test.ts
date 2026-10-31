// Review mode's sell order sheet: a buyer's quote read by part number against
// a PO's lines. The preview writes nothing; Review mode applies each price
// through the inventory line PATCH.

import { describe, it, expect, beforeEach } from 'vitest';
import ExcelJS from 'exceljs';
import { getTestDb, resetDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const USD_CNY = 7.2154;

type Cell = {
  sheet: string; rowNumber: number; rawPrice: string; currency: string;
  price: number | null; listedPrice?: number;
};
type Match = { lineId: string; status: string; cell?: Cell; cells?: Cell[] };
type Preview = {
  fx: { oneUsdInQuote: number; source: string } | null;
  lines: Match[];
  notOnPo: number;
};

const ram = (partNumber: string, unitCost: number) => ({
  category: 'RAM', brand: 'Samsung', capacity: '32GB', type: 'DDR4', classification: 'RDIMM',
  speed: '3200', partNumber, condition: 'Pulled — Tested', qty: 2, unitCost,
});

// A Reviewing PO with one line per part number, in that order.
async function createReviewing(pur: string, mgr: string, parts: string[]): Promise<{ id: string; lineIds: string[] }> {
  const created = await api<{ id: string }>('POST', '/api/orders', {
    token: pur,
    body: {
      paypalTxnId: 'TESTPAYTXN0000001',
      category: 'RAM', warehouseId: 'WH-LA1', payment: 'company',
      lines: parts.map((pn, i) => ram(pn, 20 + i)),
    },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  expect((await api('POST', `/api/orders/${id}/advance`, { token: pur })).status).toBe(200);
  expect((await api('POST', `/api/orders/${id}/advance`, { token: mgr, body: { toStage: 'reviewing' } })).status).toBe(200);
  const got = await api<{ order: { lines: { id: string; partNumber: string }[] } }>('GET', `/api/orders/${id}`, { token: mgr });
  const byPart = new Map(got.body.order.lines.map(l => [l.partNumber, l.id]));
  return { id, lineIds: parts.map(p => byPart.get(p)!) };
}

async function sheet(rows: unknown[][]): Promise<Blob> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Quote');
  for (const r of rows) ws.addRow(r);
  return new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_MIME });
}

async function seedRate(): Promise<void> {
  await getTestDb()`
    INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_date)
    VALUES ('USD', 'CNY', ${USD_CNY}, 'manual', CURRENT_DATE)
  `;
}

const preview = (id: string, fields: Record<string, string | Blob>, token: string) =>
  multipart(`/api/orders/${id}/price-sheet/preview`, fields, { token });

describe('POST /api/orders/:id/price-sheet/preview', () => {
  let pur: string;
  let mgr: string;
  beforeEach(async () => {
    await resetDb();
    pur = (await loginAs(MARCUS)).token;
    mgr = (await loginAs(ALEX)).token;
  });

  it('matches each line by canonical part number and writes nothing', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr, [
      'SHEET-A1', 'SHEET-B2', 'SHEET-C3', 'SHEET-D4', 'SHEET-E5', 'SHEET-F6', 'SHEET-G7', 'SHEET-H8',
    ]);
    const [a, b, cLine, d, e, f, g, h] = lineIds as [string, string, string, string, string, string, string, string];
    // A line with nothing to match on, as a mixed lot has.
    await getTestDb()`UPDATE order_lines SET part_number = NULL WHERE id = ${g}`;

    const file = await sheet([
      ['Sell order SO-1182'],
      ['#', 'Part Number', 'Qty', 'Unit Price', 'Total'],
      [1, 'sheet a1', 2, 54.5, 109],
      [2, 'SHEET-C3', 2, 30, 60],
      [3, 'SHEET-C3', 2, 31, 62],
      [4, 'SHEET-D4', 2, null, null],
      [5, 'SHEET-E5', 2, 12, 24],
      [6, 'SHEET-E5', 2, 12, 24],
      [7, 'NOT-ON-PO', 1, 99, 99],
      [8, 'SHEET-F6', 1, 'call', null],
      [9, '-', 1, 5, 5],
      [10, 'SHEET-H8', 1, 50, 50],
      [11, 'SHEET-H8', 1, 0, 0],
      [12, 'NOT-ON-PO', 1, 99, 99],
      [13, 'BLANK-ONLY', 1, null, null],
    ]);
    const res = await preview(id, { file }, mgr);
    expect(res.status).toBe(200);
    const body = res.body as Preview;
    const of = (lineId: string) => body.lines.find(l => l.lineId === lineId)!;

    expect(of(a)).toMatchObject({ status: 'matched', cell: { rowNumber: 3, price: 54.5, currency: 'USD' } });
    expect(of(a).cell!.listedPrice).toBeUndefined();
    expect(of(b).status).toBe('not-in-sheet');
    // Two prices for one part are left for the manager, both cited.
    expect(of(cLine).status).toBe('conflict');
    expect(of(cLine).cells!.map(x => x.price)).toEqual([30, 31]);
    expect(of(d)).toMatchObject({ status: 'no-price', cell: { rowNumber: 6 } });
    // The same price twice is one price; the last row is cited.
    expect(of(e)).toMatchObject({ status: 'matched', cell: { rowNumber: 8, price: 12 } });
    expect(of(f)).toMatchObject({ status: 'invalid-price', cell: { rowNumber: 10, rawPrice: 'call' } });
    expect(of(g).status).toBe('no-part');
    // A later 0 is "not buying": against a price, it is the manager's call.
    expect(of(h).status).toBe('conflict');
    expect(of(h).cells!.map(x => x.price)).toEqual([50, 0]);
    // Parts the sheet prices that the PO lacks: a repeat or a blank row is
    // not another part.
    expect(body.notOnPo).toBe(1);
    expect(body.fx).toBeNull();

    const prices = await getTestDb()<{ sell_price: string | null }[]>`
      SELECT sell_price FROM order_lines WHERE order_id = ${id}`;
    expect(prices.every(p => p.sell_price === null)).toBe(true);
  });

  it('matches a Micron line with no chip marking yet by part number on a sheet with a Short code column', async () => {
    const { id, lineIds } = await createReviewing(pur, mgr, ['MTA36ASF4G72PZ-3G2', 'MTA18ASF2G72PZ-3G2']);
    const [one, two] = lineIds as [string, string];
    await getTestDb()`UPDATE order_lines SET brand = 'Micron', chip_number = NULL WHERE id IN (${one}, ${two})`;
    const file = await sheet([
      ['Part Number', 'Short code', 'Unit Price'],
      ['MTA36ASF4G72PZ-3G2', 'AQB', 40],
      ['MTA18ASF2G72PZ-3G2', 'AQB', 20],
      ['MTA18ASF2G72PZ-3G2', 'AQD', 22],
    ]);
    const res = await preview(id, { file }, mgr);
    expect(res.status).toBe(200);
    const byLine = new Map((res.body as Preview).lines.map(m => [m.lineId, m]));
    expect(byLine.get(one)).toMatchObject({ status: 'matched', cell: { price: 40 } });
    // Two dies at two prices: which one this lot is cannot be told yet.
    expect(byLine.get(two)!.status).toBe('conflict');
  });

  it('converts yuan at the FX ledger rate and keeps the yuan beside the dollars', async () => {
    await seedRate();
    const { id, lineIds } = await createReviewing(pur, mgr, ['SHEET-CNY1', 'SHEET-CNY2']);
    const [one, two] = lineIds as [string, string];
    const file = await sheet([
      ['Part Number', 'Unit Price'],
      ['SHEET-CNY1', 395],
      // A cell that names its currency keeps it, whatever the switch says.
      ['SHEET-CNY2', '$20'],
    ]);

    const res = await preview(id, { file, currency: 'CNY' }, mgr);
    expect(res.status).toBe(200);
    const body = res.body as Preview;
    const cell = (lineId: string) => body.lines.find(l => l.lineId === lineId)!.cell!;
    expect(cell(one)).toMatchObject({ currency: 'CNY', listedPrice: 395, price: +(395 / USD_CNY).toFixed(2) });
    expect(cell(two)).toMatchObject({ currency: 'USD', price: 20 });
    expect(cell(two).listedPrice).toBeUndefined();
    expect(body.fx?.oneUsdInQuote).toBeCloseTo(USD_CNY, 6);
    expect(body.fx?.source).toBe('manual');
  });

  it('is a manager door, refuses an archived PO, and names a sheet it cannot read', async () => {
    const { id } = await createReviewing(pur, mgr, ['SHEET-X1']);
    const file = await sheet([['Part Number', 'Unit Price'], ['SHEET-X1', 10]]);

    expect((await preview(id, { file }, pur)).status).toBe(403);
    expect((await preview('PO-NOPE', { file }, mgr)).status).toBe(404);
    expect((await preview(id, { file, currency: 'EUR' }, mgr)).status).toBe(400);

    const noColumns = await preview(id, { file: await sheet([['Item', 'Qty'], ['x', 1]]) }, mgr);
    expect(noColumns.status).toBe(400);
    expect(noColumns.body).toMatchObject({ code: 'columns-not-found' });

    const notXlsx = await preview(id, { file: new Blob(['a,b\n1,2'], { type: 'text/csv' }) }, mgr);
    expect(notXlsx.status).toBe(400);

    await getTestDb()`UPDATE orders SET archived_at = NOW() WHERE id = ${id}`;
    expect((await preview(id, { file }, mgr)).status).toBe(409);
  });
});
