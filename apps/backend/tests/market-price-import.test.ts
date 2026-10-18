import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import {
  readPriceSheetRows,
  PriceColumnsNotFoundError,
} from '../src/services/sellOrderPriceImport';
import { resetDb, getTestDb } from './helpers/db';
import { api, multipart } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PREVIEW = '/api/market/price-import/preview';
const APPLY = '/api/market/price-import/apply';

type PreviewRow = {
  sheet: string;
  rowNumber: number;
  rawPart: string;
  rawPrice: string;
  price: number | null;
  currency: string;
  listedPrice?: number;
  status: string;
  refPriceId?: string;
  partNumber?: string | null;
  label?: string;
  oldPrice?: number | null;
  oldMaxBuy?: number | null;
  newMaxBuy?: number | null;
};
type Preview = {
  targetMargin: number;
  fx: { oneUsdInQuote: number; source: string } | null;
  rows: PreviewRow[];
  summary: Record<string, number>;
};

function wbWith(rows: unknown[][], sheetName = 'Prices'): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  return wb;
}

async function blobOf(wb: ExcelJS.Workbook): Promise<Blob> {
  return new Blob([await wb.xlsx.writeBuffer()], { type: XLSX_MIME });
}

// Through the bytes and back, so cell formats are read the way an uploaded
// file's are.
async function reload(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const out = new ExcelJS.Workbook();
  await out.xlsx.load(await wb.xlsx.writeBuffer());
  return out;
}

const maxBuy = (basis: number, margin: number) => +(basis * (1 - margin)).toFixed(2);

// ---------------------------------------------------------------------------
// readPriceSheetRows — the reader shared with the sell-order bid import.
// ---------------------------------------------------------------------------

describe('readPriceSheetRows', () => {
  it('reads only Part Number + Unit Price, below any title rows', () => {
    const rows = readPriceSheetRows(wbWith([
      ['Vendor quote — October'],
      ['Description', 'Qty', 'Part Number', 'Condition', 'Unit Price', 'Line Total'],
      ['16GB DDR4', 10, 'M393A2K43BB1-CTD', 'pulled', '$1,200.50', 12005],
      ['blank part', 3, null, 'new', 9, 27],
    ]));
    expect(rows).toEqual([{
      sheet: 'Prices',
      rowNumber: 3,
      rawPart: 'M393A2K43BB1-CTD',
      canonPart: 'M393A2K43BB1CTD',
      price: 1200.5,
      priceKind: 'ok',
      rawPrice: '$1,200.50',
      currency: 'USD',
    }]);
  });

  it('marks yuan from the header, the cell text or the cell format', async () => {
    const byHeader = readPriceSheetRows(wbWith([
      ['Part Number', 'Unit Price (CNY)'],
      ['PN-1', 300],
    ]));
    expect(byHeader[0]).toMatchObject({ price: 300, currency: 'CNY' });

    const byChineseHeader = readPriceSheetRows(wbWith([
      ['型号', '单价（元）'],
      ['PN-1', 300],
    ]));
    expect(byChineseHeader[0]).toMatchObject({ price: 300, currency: 'CNY' });

    const byCell = readPriceSheetRows(wbWith([
      ['Part Number', 'Unit Price (USD)'],
      ['PN-1', '¥300'],
      ['PN-2', 45],
    ]));
    expect(byCell.map(r => r.currency)).toEqual(['CNY', 'USD']);

    const formatted = wbWith([
      ['Part Number', 'Unit Price'],
      ['PN-1', 300],
    ]);
    formatted.worksheets[0].getCell('B2').numFmt = '"¥"#,##0.00';
    const byFormat = readPriceSheetRows(await reload(formatted));
    expect(byFormat[0]).toMatchObject({ price: 300, currency: 'CNY' });
  });

  it('reads 美元 as dollars, and marks other currencies and a yuan tab', async () => {
    const usd = readPriceSheetRows(wbWith([['型号', '单价（美元）'], ['PN-1', 300]]));
    expect(usd[0]).toMatchObject({ price: 300, currency: 'USD' });

    const unmarked = readPriceSheetRows(wbWith([['Part Number', 'Unit Price'], ['PN-1', 300]]));
    expect(unmarked[0]).toMatchObject({ price: 300, currency: null });

    const tab = readPriceSheetRows(wbWith([['Part Number', 'Unit Price'], ['PN-1', 280]], 'RMB'));
    expect(tab[0]).toMatchObject({ currency: 'CNY' });

    const eur = readPriceSheetRows(wbWith([['Part Number', 'Unit Price (EUR)'], ['PN-1', 40]]));
    expect(eur[0]).toMatchObject({ currency: 'EUR' });

    const formatted = wbWith([['Part Number', 'Unit Price'], ['PN-1', 40]]);
    formatted.worksheets[0].getCell('B2').numFmt = '[$€-407]#,##0.00';
    expect((readPriceSheetRows(await reload(formatted)))[0]).toMatchObject({ currency: 'EUR' });
  });

  it('reads a bare $ as dollars, but not HK$ or the [$…] of a number format', async () => {
    const cells = readPriceSheetRows(wbWith([
      ['Part Number', 'Unit Price'],
      ['PN-1', '$45'],
      ['PN-2', 'HK$45'],
      ['PN-3', 'US$45'],
    ]));
    expect(cells.map(r => r.currency)).toEqual(['USD', 'HKD', 'USD']);

    const header = readPriceSheetRows(wbWith([['Part Number', 'Price ($)'], ['PN-1', 45]]));
    expect(header[0]).toMatchObject({ currency: 'USD' });

    const formats = wbWith([['Part Number', 'Unit Price'], ['PN-1', 1], ['PN-2', 2], ['PN-3', 3], ['PN-4', 4]]);
    const ws = formats.worksheets[0];
    ws.getCell('B2').numFmt = '"$"#,##0.00';
    ws.getCell('B3').numFmt = '[$$-409]#,##0.00';
    ws.getCell('B4').numFmt = '[$HK$-C04]#,##0.00';
    ws.getCell('B5').numFmt = '[$¥-804]#,##0.00';
    expect((readPriceSheetRows(await reload(formats))).map(r => r.currency))
      .toEqual(['USD', 'USD', 'HKD', 'CNY']);
  });

  it('throws when no tab has both columns', () => {
    expect(() => readPriceSheetRows(wbWith([['Item', 'Qty'], ['x', 1]])))
      .toThrow(PriceColumnsNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// HTTP: preview + apply
// ---------------------------------------------------------------------------

// The ledger's latest row, as a manager override would leave it: 1 USD in
// yuan. ¥300 converts to $41.58 and ¥720 to $99.79 at this rate.
const USD_CNY = 7.2154;

async function seedRate(): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO fx_rates (base_currency, quote_currency, rate, source, effective_date)
    VALUES ('USD', 'CNY', ${USD_CNY}, 'manual', CURRENT_DATE)
  `;
}

async function seedRef(
  id: string,
  partNumber: string,
  opts: { category?: string; lastPrice?: number | null; avgSell?: number; ageDays?: number } = {},
): Promise<void> {
  const sql = getTestDb();
  await sql`
    INSERT INTO ref_prices (id, category, label, part_number, avg_sell, last_price, last_price_at, updated_at)
    VALUES (${id}, ${opts.category ?? 'RAM'}, ${'label ' + id}, ${partNumber},
            ${opts.avgSell ?? 90}, ${opts.lastPrice ?? null},
            ${opts.lastPrice == null ? null : sql`NOW() - INTERVAL '30 days'`},
            NOW() - ${opts.ageDays ?? 0}::int * INTERVAL '1 day')
  `;
}

describe('POST /api/market/price-import/preview', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('classifies every row and writes nothing', async () => {
    await seedRef('rp-a1', 'MKT-IMP-A1', { lastPrice: 100 });
    await seedRef('rp-b2', 'MKT-IMP-B2', { avgSell: 50 });
    await seedRef('rp-c3', 'MKT-IMP-C3', { lastPrice: 10 });
    await seedRef('rp-d4', 'MKT-IMP-D4', { lastPrice: 10 });
    await seedRef('rp-e5', 'MKT-IMP-E5', { lastPrice: 10 });
    await seedRef('rp-f6', 'MKT-IMP-F6', { lastPrice: 10 });
    await seedRef('rp-g7', 'MKT-IMP-G7', { lastPrice: 10 });
    await seedRate();
    const { token } = await loginAs(ALEX);

    const wb = wbWith([
      ['Quote from a broker'],
      ['Item', 'Qty', 'Part Number', 'Unit Price (USD)', 'Total'],
      ['ram', 4, 'mkt imp a1', 80, 320],
      ['ssd', 1, 'MKT-IMP-B2', 40, 40],
      ['x', 1, 'NOPE-999', 10, 10],
      ['x', 1, 'MKT-IMP-C3', null, null],
      ['x', 1, 'MKT-IMP-D4', 0, 0],
      ['x', 1, 'MKT-IMP-E5', 'call', null],
      ['x', 1, 'MKT-IMP-F6', '¥300', null],
      ['x', 1, 'MKT-IMP-A1', 85, 85],
      ['x', 1, '-', 5, 5],
      ['x', 1, 'MKT-IMP-G7', 40, null],
    ]);
    wb.worksheets[0].getCell('D12').numFmt = '[$€-407]#,##0.00';
    const file = await blobOf(wb);
    const res = await multipart(PREVIEW, { file }, { token });
    expect(res.status).toBe(200);
    const body = res.body as Preview;
    const m = body.targetMargin;

    expect(body.summary).toEqual({
      matched: 3, notOnMarket: 2, noPrice: 2, invalid: 1, otherCurrency: 1, duplicate: 1,
    });
    const status = (rowNumber: number) => body.rows.find(r => r.rowNumber === rowNumber)?.status;
    expect(status(3)).toBe('duplicate');
    expect(status(5)).toBe('not-on-market');
    expect(status(6)).toBe('no-price');
    expect(status(7)).toBe('no-price');
    expect(status(8)).toBe('invalid-price');
    expect(status(11)).toBe('not-on-market');
    expect(body.rows.find(r => r.rowNumber === 12)).toMatchObject({
      status: 'other-currency', currency: 'EUR', rawPrice: '40',
    });
    // The cell's ¥ outranks the column's (USD): converted, not skipped.
    expect(body.rows.find(r => r.rowNumber === 9)).toMatchObject({
      status: 'matched', refPriceId: 'rp-f6', currency: 'CNY', listedPrice: 300,
      price: 41.58, newMaxBuy: maxBuy(41.58, m),
    });
    expect(body.fx?.oneUsdInQuote).toBeCloseTo(USD_CNY, 6);
    expect(body.fx?.source).toBe('manual');

    expect(body.rows.find(r => r.rowNumber === 10)).toMatchObject({
      status: 'matched', refPriceId: 'rp-a1', partNumber: 'MKT-IMP-A1', label: 'label rp-a1',
      currency: 'USD', price: 85, oldPrice: 100, oldMaxBuy: maxBuy(100, m), newMaxBuy: maxBuy(85, m),
    });
    // No recorded price yet: the current max buy comes off avg_sell, as on the table.
    expect(body.rows.find(r => r.rowNumber === 4)).toMatchObject({
      status: 'matched', refPriceId: 'rp-b2', oldPrice: null,
      oldMaxBuy: maxBuy(50, m), newMaxBuy: maxBuy(40, m),
    });

    const sql = getTestDb();
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ref_price_events WHERE ref_price_id LIKE 'rp-%'
    `;
    expect(n).toBe(0);
  });

  it('reads an unmarked list in the currency it is given; a marked price keeps its own', async () => {
    await seedRef('rp-a1', 'MKT-CNY-A1', { lastPrice: 100 });
    await seedRef('rp-b2', 'MKT-CNY-B2', { lastPrice: 10 });
    await seedRef('rp-c3', 'MKT-CNY-C3', { lastPrice: 10 });
    await seedRef('rp-d4', 'MKT-CNY-D4', { lastPrice: 10 });
    await seedRate();
    const { token } = await loginAs(ALEX);
    const wb = wbWith([
      ['Part Number', 'Unit Price'],
      ['MKT-CNY-A1', 720],
      ['MKT-CNY-B2', '$15'],
      // Under half a cent once converted — written, it would be $0.00.
      ['MKT-CNY-C3', 0.03],
      ['MKT-CNY-D4', 80],
    ]);
    wb.worksheets[0].getCell('B5').numFmt = '[$HK$-C04]#,##0.00';
    const file = await blobOf(wb);

    const yuan = await multipart(PREVIEW, { file, currency: 'CNY' }, { token });
    expect(yuan.status).toBe(200);
    const body = yuan.body as Preview;
    const row = (rowNumber: number) => body.rows.find(r => r.rowNumber === rowNumber);
    expect(row(2)).toMatchObject({
      status: 'matched', currency: 'CNY', listedPrice: 720, price: 99.79,
      oldMaxBuy: maxBuy(100, body.targetMargin), newMaxBuy: maxBuy(99.79, body.targetMargin),
    });
    expect(row(3)).toMatchObject({ status: 'matched', currency: 'USD', price: 15 });
    expect(row(3)?.listedPrice).toBeUndefined();
    expect(row(4)?.status).toBe('no-price');
    expect(row(5)).toMatchObject({ status: 'other-currency', currency: 'HKD' });
    expect(body.fx?.oneUsdInQuote).toBeCloseTo(USD_CNY, 6);

    // The same file read as dollars: nothing converts, so no rate is looked up.
    const dollars = (await multipart(PREVIEW, { file }, { token })).body as Preview;
    expect(dollars.rows.find(r => r.rowNumber === 2)).toMatchObject({
      status: 'matched', currency: 'USD', price: 720,
    });
    expect(dollars.rows.find(r => r.rowNumber === 4)).toMatchObject({ status: 'matched', price: 0.03 });
    expect(dollars.fx).toBeNull();

    // A column that names dollars is never converted, whatever the import was given.
    const named = await blobOf(wbWith([['Part Number', 'Unit Price (USD)'], ['MKT-CNY-A1', 90]]));
    const kept = (await multipart(PREVIEW, { file: named, currency: 'CNY' }, { token })).body as Preview;
    expect(kept.rows[0]).toMatchObject({ status: 'matched', currency: 'USD', price: 90 });
  });

  it('writes to the most recently maintained of two rows sharing a part number', async () => {
    await seedRef('rp-old', 'MKT-SHARED', { category: 'RAM', ageDays: 3 });
    await seedRef('rp-new', 'mkt shared', { category: 'SSD' });
    const { token } = await loginAs(ALEX);
    const file = await blobOf(wbWith([['Part Number', 'Price'], ['MKT-SHARED', 12]]));
    const res = await multipart(PREVIEW, { file }, { token });
    expect(res.status).toBe(200);
    expect((res.body as Preview).rows[0]).toMatchObject({ status: 'matched', refPriceId: 'rp-new' });
  });

  it('accepts a sheet over the 1 MiB JSON cap', async () => {
    await seedRef('rp-big', 'MKT-BIG');
    const { token } = await loginAs(ALEX);
    const wb = wbWith([['Part Number', 'Unit Price'], ['MKT-BIG', 7]]);
    // Random bytes don't deflate, so the image keeps the file ~1.5 MB.
    const image = wb.addImage({ buffer: randomBytes(1_500_000), extension: 'png' });
    wb.worksheets[0].addImage(image, 'D1:E4');
    const file = await blobOf(wb);
    expect(file.size).toBeGreaterThan(1_048_576);
    const res = await multipart(PREVIEW, { file }, { token });
    expect(res.status).toBe(200);
    expect((res.body as Preview).summary.matched).toBe(1);
  });

  it('refuses a purchaser, a missing or non-xlsx file, unknown columns and oversize', async () => {
    const purchaser = (await loginAs(MARCUS)).token;
    const { token } = await loginAs(ALEX);
    const good = await blobOf(wbWith([['Part Number', 'Unit Price'], ['X', 1]]));

    expect((await multipart(PREVIEW, { file: good }, { token: purchaser })).status).toBe(403);
    expect((await multipart(PREVIEW, {}, { token })).status).toBe(400);
    expect((await multipart(PREVIEW, { file: good, currency: 'EUR' }, { token })).status).toBe(400);
    const txt = await multipart(PREVIEW, {
      file: new Blob(['not a spreadsheet'], { type: 'text/plain' }),
    }, { token });
    expect(txt.status).toBe(400);
    const cols = await multipart(PREVIEW, {
      file: await blobOf(wbWith([['just', 'cells'], [1, 2]])),
    }, { token });
    expect(cols.status).toBe(400);
    expect((cols.body as { code: string }).code).toBe('columns-not-found');
    const big = new Blob([new Uint8Array(9 * 1024 * 1024)], { type: XLSX_MIME });
    expect((await multipart(PREVIEW, { file: big }, { token })).status).toBe(413);
  });
});

describe('POST /api/market/price-import/apply', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('records each price as an import data point and moves the max buy', async () => {
    await seedRef('rp-a1', 'MKT-IMP-A1', { lastPrice: 100 });
    const { token, user } = await loginAs(ALEX);

    const res = await api('POST', APPLY, {
      token,
      body: { fileName: '  broker-oct.xlsx ', prices: [{ id: 'rp-a1', price: 85 }, { id: 'rp-gone', price: 9 }] },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 1, notFound: 1 });

    const sql = getTestDb();
    const rp = (await sql<{ last_price: number; last_price_source: string; fresh: boolean }[]>`
      SELECT last_price::float AS last_price, last_price_source,
             last_price_at > NOW() - INTERVAL '1 minute' AS fresh
      FROM ref_prices WHERE id = 'rp-a1'
    `)[0];
    expect(rp).toEqual({ last_price: 85, last_price_source: `import:${ALEX}`, fresh: true });
    const ev = (await sql<{ price: number; source: string; note: string; actor_user_id: string }[]>`
      SELECT price::float AS price, source, note, actor_user_id
      FROM ref_price_events WHERE ref_price_id = 'rp-a1'
    `);
    expect(ev).toEqual([{ price: 85, source: `import:${ALEX}`, note: 'broker-oct.xlsx', actor_user_id: user.id }]);

    const list = await api<{ targetMargin: number; items: { id: string; lastPrice: number; maxBuy: number }[] }>(
      'GET', '/api/market?q=mkt-imp-a1', { token },
    );
    const item = list.body.items.find(i => i.id === 'rp-a1');
    expect(item).toMatchObject({ lastPrice: 85, maxBuy: maxBuy(85, list.body.targetMargin) });
  });

  it('validates the payload', async () => {
    await seedRef('rp-a1', 'MKT-IMP-A1', { lastPrice: 100 });
    const purchaser = (await loginAs(MARCUS)).token;
    const { token } = await loginAs(ALEX);
    const post = (body: unknown, as = token) => api('POST', APPLY, { token: as, body });

    expect((await post({ prices: [{ id: 'rp-a1', price: 85 }] }, purchaser)).status).toBe(403);
    expect((await post({ prices: [] })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ prices: [{ id: 'rp-a1', price: 0 }] })).status).toBe(400);
    expect((await post({ prices: [{ id: 'rp-a1', price: -1 }] })).status).toBe(400);
    expect((await post({ prices: [{ id: 'rp-a1', price: '85' }] })).status).toBe(400);
    expect((await post({ prices: [{ price: 85 }] })).status).toBe(400);
    expect((await post({ prices: [{ id: 'rp-a1', price: 1 }, { id: 'rp-a1', price: 2 }] })).status).toBe(400);
    const many = Array.from({ length: 5001 }, (_, i) => ({ id: `rp-${i}`, price: 1 }));
    expect((await post({ prices: many })).status).toBe(413);

    const sql = getTestDb();
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM ref_price_events WHERE ref_price_id = 'rp-a1'
    `;
    expect(n).toBe(0);
  });
});
