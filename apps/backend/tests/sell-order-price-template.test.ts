import { describe, it, expect, beforeEach, vi } from 'vitest';
import ExcelJS from 'exceljs';
import app from '../src/index';
import { resetDb } from './helpers/db';
import { api, multipart, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import {
  buildPriceTemplateWorkbook, buildPackingListWorkbook,
} from '../src/lib/sellOrderPriceTemplate';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function getRaw(path: string, token: string): Promise<Response> {
  return app.fetch(
    new Request('http://test' + path, {
      headers: { cookie: `at=${token}`, 'X-Requested-By': 'recycle-erp' },
    }),
    testEnv,
  );
}

async function createOrder(token: string, opts: { currency?: string; lines?: object[] } = {}): Promise<string> {
  const cust = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId: cust.body.items[0].id,
      ...(opts.currency ? { currency: opts.currency } : {}),
      lines: opts.lines ?? [
        { category: 'RAM', label: 'DIMM A', partNumber: 'TPL-A1', qty: 2, unitPrice: 40, warehouseId: 'WH-LA1' },
        { category: 'SSD', label: 'Drive B', partNumber: 'TPL-B2', qty: 1, unitPrice: 90, warehouseId: 'WH-LA1' },
      ],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function loadWorkbook(res: Response): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb;
}

// The bid workbook is category tabs and nothing else; the packing tabs are a
// separate download with their own layout ('Part #', no Unit Price), asserted
// in the GET /:id/packing-list block below.
const CATEGORY_TABS = new Set(['RAM', 'SSD', 'HDD', 'Other']);
const categoryTabs = (wb: ExcelJS.Workbook): ExcelJS.Worksheet[] =>
  wb.worksheets.filter(w => CATEGORY_TABS.has(w.name));

// Header row is not at a fixed position (an instruction block sits above it) —
// locate it the same way the import parser does: by its text.
function findHeaderRow(ws: ExcelJS.Worksheet): { row: number; cols: Map<string, number> } {
  for (let r = 1; r <= 15; r++) {
    const cols = new Map<string, number>();
    const row = ws.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      const v = row.getCell(c).value;
      if (typeof v === 'string' && v.trim()) cols.set(v.trim(), c);
    }
    if ([...cols.keys()].some(h => h === 'Part Number')) return { row: r, cols };
  }
  throw new Error('header row not found');
}

describe('GET /api/sell-orders/:id/price-template', () => {
  beforeEach(async () => { await resetDb(); });

  it('streams one tab per category with all parts and an instruction block per tab', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);

    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);
    expect(res.headers.get('content-disposition')).toContain('price-template');

    const wb = await loadWorkbook(res);
    // RAM line + SSD line → a dedicated sub-sheet each, in fixed order. The
    // packing checklist is not in this file.
    expect(wb.worksheets.map(w => w.name)).toEqual(['RAM', 'SSD']);

    const parts: string[] = [];
    for (const ws of categoryTabs(wb)) {
      const { row: headerRow, cols } = findHeaderRow(ws);
      expect(headerRow).toBeGreaterThan(1);
      // Every tab is self-contained: instruction block names the order and
      // the fill-in currency.
      const preamble = [1, 2, 3].map(r =>
        (ws.getRow(r).values as unknown[]).map(v => String(v ?? '')).join(' ')).join(' ');
      expect(preamble).toContain(id);
      expect(preamble).toContain('USD');
      const partCol = cols.get('Part Number')!;
      for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const v = ws.getRow(r).getCell(partCol).value;
        if (v) parts.push(String(v));
      }
    }
    expect(parts.sort()).toEqual(['TPL-A1', 'TPL-B2']);
  });

  it('groups multi-warehouse lines into one row with summed qty', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, {
      lines: [
        { category: 'RAM', label: 'DIMM A', partNumber: 'TPL-DUP', qty: 2, unitPrice: 10, warehouseId: 'WH-LA1' },
        { category: 'RAM', label: 'DIMM A', partNumber: 'TPL-DUP', qty: 3, unitPrice: 10, warehouseId: 'WH-NJ2' },
      ],
    });
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    const ws = (await loadWorkbook(res)).worksheets[0];
    const { row: headerRow, cols } = findHeaderRow(ws);
    const partCol = cols.get('Part Number')!;
    const qtyCol = cols.get('Qty')!;
    const dataRows = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      if (ws.getRow(r).getCell(partCol).value) dataRows.push(r);
    }
    expect(dataRows).toHaveLength(1);
    expect(Number(ws.getRow(dataRows[0]).getCell(qtyCol).value)).toBe(5);
  });

  it('leaves Unit Price blank on an unprotected sheet, formulas Line Total', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    const wb = await loadWorkbook(res);
    expect(categoryTabs(wb).length).toBeGreaterThan(1);
    for (const ws of categoryTabs(wb)) {
      const { row: headerRow, cols } = findHeaderRow(ws);
      const priceCol = cols.get('Unit Price (USD)')!;
      const totalCol = cols.get('Line Total (USD)')!;
      expect(priceCol).toBeGreaterThan(0);
      expect(totalCol).toBeGreaterThan(0);
      // The workbook ships with no sheet protection at all — a manager can
      // reshape a bid tab without lifting a lock first.
      expect(ws.sheetProtection).toBeFalsy();

      for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        if (!row.getCell(cols.get('Part Number')!).value) continue;
        const priceCell = row.getCell(priceCol);
        // Blank bid sheet: existing order prices must not leak to the vendor.
        expect(priceCell.value).toBeNull();
        const totalCell = row.getCell(totalCol);
        expect(totalCell.formula).toBeTruthy();
      }
    }
  });

  it('sorts and filters from the header row on every category tab', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    const wb = await loadWorkbook(res);
    expect(categoryTabs(wb).length).toBeGreaterThan(1);
    for (const ws of categoryTabs(wb)) {
      const { row: headerRow, cols } = findHeaderRow(ws);
      const lastCol = Math.max(...cols.values());
      // The dropdowns must span the whole header, '#' through 'Note / 备注',
      // and reach the one product row this order puts on each tab. '#' is not
      // always column A: the RAM tab carries merged group labels to its left,
      // and Excel refuses to sort a range holding unequal merges.
      const first = `${ws.getColumn(cols.get('#')!).letter}${headerRow}`;
      const last = `${ws.getColumn(lastCol).letter}${headerRow + 1}`;
      expect(ws.autoFilter).toBe(`${first}:${last}`);
      // No protection to grey the dropdowns out or to refuse a sort — that is
      // what makes the filter usable without a trip through Review > Unprotect.
      expect(ws.sheetProtection).toBeFalsy();
    }
  });

  it('ships rows in the default order — brand, then capacity, speed', async () => {
    const ram = (label: string, specs: Record<string, string | number>) => ({
      category: 'RAM', label, partNumber: label, condition: null,
      qty: 1, imageUrl: null, specs,
    });
    // Deliberately scrambled on the way in, including a manual line with no
    // specs at all.
    const buf = await buildPriceTemplateWorkbook(
      { id: 'SL-SORT', customerName: 'Acme', currencyCode: 'USD' },
      [
        ram('d', { capacity: '16GB', rank: '2Rx4', speed: '2400', brand: 'Micron' }),
        ram('manual', {}),
        ram('f', { capacity: '128GB', rank: '2Rx4', speed: '3200', brand: 'Samsung' }),
        ram('b', { capacity: '16GB', rank: '1Rx8', speed: '3200', brand: 'Hynix' }),
        ram('e', { capacity: '8GB', rank: '2Rx4', speed: '3200', brand: 'Samsung' }),
        ram('c', { capacity: '16GB', rank: '2Rx4', speed: '2400', brand: 'Hynix' }),
      ],
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const { row: headerRow, cols } = findHeaderRow(ws);
    const labels: string[] = [];
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      labels.push(String(ws.getRow(r).getCell(cols.get('Item')!).value ?? ''));
    }
    // Hynix, Micron, Samsung — then within a brand, capacity numerically
    // (8GB before 128GB, not lexically) and speed last. Rank does not sort:
    // the Hynix pair splits on speed alone. The spec-less manual line sinks.
    expect(labels).toEqual(['c', 'b', 'd', 'e', 'f', 'manual']);
  });

  it('groups the RAM tab by device then DDR generation with merged labels', async () => {
    const ram = (label: string, specs: Record<string, string | number>) => ({
      category: 'RAM', label, partNumber: label, condition: null,
      qty: 1, imageUrl: null, specs,
    });
    const ssd = {
      category: 'SSD', label: 'ssd', partNumber: 'ssd', condition: null,
      qty: 1, imageUrl: null, specs: { brand: 'Intel', capacity: '1TB' },
    };
    // Scrambled on the way in. Two DDR4 runs (one per device group) must
    // stay two cells; the type-less manual line sinks to a trailing bucket.
    const products = [
      ram('srv-ddr4-b', { type: 'Server', generation: 'DDR4', brand: 'Samsung', capacity: '32GB' }),
      ram('lap-ddr4',   { type: 'Laptop', generation: 'DDR4', brand: 'Samsung', capacity: '8GB' }),
      ram('manual',     {}),
      ram('srv-ddr3',   { type: 'Server', generation: 'DDR3', brand: 'Hynix',   capacity: '16GB' }),
      ram('desk-ddr4',  { type: 'Desktop', generation: 'DDR4', brand: 'Micron', capacity: '8GB' }),
      ram('desk-ddr5',  { type: 'Desktop', generation: 'DDR5', brand: 'Micron', capacity: '16GB' }),
      ram('srv-ddr4-a', { type: 'Server', generation: 'DDR4', brand: 'Hynix',   capacity: '32GB' }),
      ram('desk-ddr3',  { type: 'Desktop', generation: 'DDR3', brand: 'Micron', capacity: '4GB' }),
      ssd,
    ];
    const buf = await buildPriceTemplateWorkbook(
      { id: 'SL-GRP', customerName: 'Acme', currencyCode: 'USD' },
      products,
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);

    const ramTab = wb.worksheets.find(w => w.name === 'RAM')!;
    const { row: headerRow, cols } = findHeaderRow(ramTab);
    // Two label columns sit left of '#'; their header cells are blank, as on
    // the desk's own sheet, so nothing here can confuse the import parser.
    expect(cols.get('#')).toBe(3);
    expect(ramTab.getRow(headerRow).getCell(1).value).toBeNull();
    expect(ramTab.getRow(headerRow).getCell(2).value).toBeNull();

    const labels: string[] = [];
    const index: number[] = [];
    for (let r = headerRow + 1; r <= ramTab.rowCount; r++) {
      labels.push(String(ramTab.getRow(r).getCell(cols.get('Item')!).value ?? ''));
      index.push(Number(ramTab.getRow(r).getCell(cols.get('#')!).value));
    }
    // Desktop & laptop before Server; DDR3 < DDR4 < DDR5 inside a device
    // group; desktop ahead of laptop inside a generation; then the usual
    // brand/capacity order (Hynix before Samsung). Type-less last.
    expect(labels).toEqual([
      'desk-ddr3', 'desk-ddr4', 'lap-ddr4', 'desk-ddr5',
      'srv-ddr3', 'srv-ddr4-a', 'srv-ddr4-b',
      'manual',
    ]);
    // '#' keeps counting across groups.
    expect(index).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // Merged spans: every row in a span reads the master's address, so assert
    // on that rather than on the (proxied) cell values.
    const first = headerRow + 1;
    const span = (col: number, r: number) => ramTab.getRow(r).getCell(col).master.address;
    const label = (col: number, r: number) => String(ramTab.getRow(r).getCell(col).value);
    // Column A: Desktop & laptop rows 1-4, Server rows 5-7, '—' row 8.
    expect(span(1, first)).toBe(`A${first}`);
    expect(span(1, first + 3)).toBe(`A${first}`);
    expect(label(1, first)).toBe('Desktop & laptop');
    expect(span(1, first + 4)).toBe(`A${first + 4}`);
    expect(span(1, first + 6)).toBe(`A${first + 4}`);
    expect(label(1, first + 4)).toBe('Server');
    expect(ramTab.getRow(first + 7).getCell(1).isMerged).toBe(false);
    expect(label(1, first + 7)).toBe('—');
    // Column B: the two DDR4 runs belong to different device groups and stay
    // apart; the lone desk-ddr5 row is a plain (unmerged) cell.
    expect(label(2, first)).toBe('DDR3');
    expect(ramTab.getRow(first).getCell(2).isMerged).toBe(false);
    expect(span(2, first + 1)).toBe(`B${first + 1}`);
    expect(span(2, first + 2)).toBe(`B${first + 1}`);
    expect(label(2, first + 1)).toBe('DDR4');
    expect(label(2, first + 3)).toBe('DDR5');
    expect(span(2, first + 5)).toBe(`B${first + 5}`);
    expect(span(2, first + 6)).toBe(`B${first + 5}`);
    expect(label(2, first + 7)).toBe('—');

    // Filter dropdowns start at '#', never on a merged column.
    expect(String(ramTab.autoFilter)).toMatch(new RegExp(`^C${headerRow}:`));

    // Tabs without device/generation specs are untouched: '#' stays in A.
    const ssdTab = wb.worksheets.find(w => w.name === 'SSD')!;
    expect(findHeaderRow(ssdTab).cols.get('#')).toBe(1);

    // The two label columns draw from separate palettes, and a group's own
    // rows are washed under it — the merges alone left the tab reading as one
    // block, which is what this colouring is for.
    const fill = (col: number, r: number): string =>
      String((ramTab.getRow(r).getCell(col).fill as { fgColor?: { argb?: string } })?.fgColor?.argb ?? '');
    // Desktop & laptop vs Server, and DDR3 vs DDR4 vs DDR5, all differ.
    expect(fill(1, first)).not.toBe(fill(1, first + 4));
    expect(fill(2, first)).not.toBe(fill(2, first + 1));
    expect(fill(2, first + 1)).not.toBe(fill(2, first + 3));
    // The device column never borrows the generation column's colour.
    expect(fill(1, first)).not.toBe(fill(2, first));
    // Rows follow their generation: the two DDR4 rows match each other and
    // not the DDR3 row above them.
    const dataCol = cols.get('Item')!;
    expect(fill(dataCol, first + 1)).toBe(fill(dataCol, first + 2));
    expect(fill(dataCol, first + 1)).not.toBe(fill(dataCol, first));
    // ...but the wash never takes the bid column's yellow, which is the only
    // thing on the sheet telling a vendor where to type.
    const priceCol = cols.get('Unit Price (USD)')!;
    expect(fill(priceCol, first + 1)).toBe('FFFFF7C2');

    // The packing workbook walks the same order and carries the same labels,
    // so bidder and picker find a product in the same place.
    const packWb = new ExcelJS.Workbook();
    await packWb.xlsx.load(
      await buildPackingListWorkbook(
        { id: 'SL-GRP', customerName: 'Acme', currencyCode: 'USD' },
        [{ warehouse: 'LA1', products }],
      ) as unknown as ArrayBuffer,
    );
    const pack = packWb.worksheets.find(w => w.name === 'Pack - LA1')!;
    // Part # sits right of the two reserved label columns and the tick box.
    const packPartCol = 2 + 2;
    const packParts: string[] = [];
    pack.eachRow((row, r) => {
      // Rows 1-2 are merged banners, which proxy their text to every cell.
      const part = row.getCell(packPartCol).value;
      if (r > 3 && typeof part === 'string' && part !== 'Part #') packParts.push(part);
    });
    expect(packParts).toEqual([
      'desk-ddr3', 'desk-ddr4', 'lap-ddr4', 'desk-ddr5',
      'srv-ddr3', 'srv-ddr4-a', 'srv-ddr4-b',
      'manual', 'ssd',
    ]);
    // Same merged spans as the bid tab: the RAM section starts on the row
    // after its header, and the SSD section below it gets no labels.
    const packFirst = pack.getRow(1).number;
    let packRamFirst = 0;
    pack.eachRow((row, r) => {
      if (!packRamFirst && String(row.getCell(packPartCol).value ?? '') === 'desk-ddr3') packRamFirst = r;
    });
    expect(packRamFirst).toBeGreaterThan(packFirst);
    const packSpan = (col: number, r: number) => pack.getRow(r).getCell(col).master.address;
    expect(packSpan(1, packRamFirst)).toBe(packSpan(1, packRamFirst + 3));
    expect(String(pack.getRow(packRamFirst).getCell(1).value)).toBe('Desktop & laptop');
    expect(String(pack.getRow(packRamFirst + 4).getCell(1).value)).toBe('Server');
    expect(packSpan(2, packRamFirst + 1)).toBe(packSpan(2, packRamFirst + 2));
    expect(String(pack.getRow(packRamFirst + 1).getCell(2).value)).toBe('DDR4');
  });

  it('labels the price columns CNY on a CNY order', async () => {
    // Frankfurter is stubbed so the CNY order's FX snapshot never hits the
    // network (same as sell-order-spreadsheet.test.ts).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ amount: 1, base: 'USD', date: '2026-06-07', rates: { CNY: 7.2154 } }),
      { status: 200 },
    )));
    try {
      const { token } = await loginAs(ALEX);
      const id = await createOrder(token, { currency: 'CNY' });
      const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
      expect(res.status).toBe(200);
      const ws = (await loadWorkbook(res)).worksheets[0];
      const { cols } = findHeaderRow(ws);
      expect(cols.get('Unit Price (CNY)')).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('includes lines that have no part number on their category tab', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, {
      lines: [
        { category: 'Other', label: 'Mystery caddy', qty: 1, unitPrice: 5, warehouseId: 'WH-LA1' },
        { category: 'RAM', label: 'DIMM A', partNumber: 'TPL-A1', qty: 2, unitPrice: 40, warehouseId: 'WH-LA1' },
      ],
    });
    const wb = await loadWorkbook(await getRaw(`/api/sell-orders/${id}/price-template`, token));
    expect(wb.worksheets.map(w => w.name)).toEqual(['RAM', 'Other']);
    const other = wb.worksheets.find(w => w.name === 'Other')!;
    const { row: headerRow, cols } = findHeaderRow(other);
    const itemCol = cols.get('Item')!;
    const items: string[] = [];
    for (let r = headerRow + 1; r <= other.rowCount; r++) {
      const v = other.getRow(r).getCell(itemCol).value;
      if (v) items.push(String(v));
    }
    expect(items).toContain('Mystery caddy');
  });

  it('each category tab carries only its own spec columns', async () => {
    const { token } = await loginAs(ALEX);
    const mixed = await createOrder(token);
    const wb = await loadWorkbook(
      await getRaw(`/api/sell-orders/${mixed}/price-template`, token),
    );
    expect(categoryTabs(wb).map(w => w.name)).toEqual(['RAM', 'SSD']);

    const { cols: ramCols } = findHeaderRow(wb.worksheets.find(w => w.name === 'RAM')!);
    for (const h of ['Brand', 'Capacity', 'Gen', 'Type', 'Class', 'Rank', 'Speed', 'Chip #']) {
      expect(ramCols.get(h)).toBeGreaterThan(0);
    }
    for (const h of ['Interface', 'Form factor', 'Health %', 'RPM', 'Detail']) {
      expect(ramCols.has(h)).toBe(false);
    }

    const { cols: ssdCols } = findHeaderRow(wb.worksheets.find(w => w.name === 'SSD')!);
    for (const h of ['Brand', 'Capacity', 'Interface', 'Form factor', 'Health %']) {
      expect(ssdCols.get(h)).toBeGreaterThan(0);
    }
    for (const h of ['Gen', 'Class', 'Rank', 'Speed', 'Chip #', 'RPM']) {
      expect(ssdCols.has(h)).toBe(false);
    }
  });

  it('every tab carries a blank Note column for vendor remarks', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const wb = await loadWorkbook(
      await getRaw(`/api/sell-orders/${id}/price-template`, token),
    );
    for (const ws of categoryTabs(wb)) {
      const { row: headerRow, cols } = findHeaderRow(ws);
      const noteCol = cols.get('Note / 备注')!;
      // Last column, after Line Total.
      expect(noteCol).toBeGreaterThan(cols.get('Line Total (USD)')!);
      // The instruction block invites remarks there.
      const preamble = [1, 2, 3].map(r =>
        (ws.getRow(r).values as unknown[]).map(v => String(v ?? '')).join(' ')).join(' ');
      expect(preamble).toContain('Note / 备注');

      for (let r = headerRow + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        if (!row.getCell(cols.get('Qty')!).value) continue;
        const noteCell = row.getCell(noteCol);
        // Nothing pre-filled from the DB — the vendor/manager types remarks.
        expect(noteCell.value).toBeNull();
      }
    }
  });

  it('never embeds images and links the photo as an Image URL hyperlink', async () => {
    // Route path: seeded scans carry stub data: URLs, which must not reach the
    // sheet — cells stay blank and nothing is embedded.
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const res = await getRaw(`/api/sell-orders/${id}/price-template`, token);
    expect(res.status).toBe(200);
    const dl = await loadWorkbook(res);
    for (const ws of dl.worksheets) expect(ws.getImages()).toHaveLength(0);
    for (const ws of categoryTabs(dl)) {
      const { cols } = findHeaderRow(ws);
      expect(cols.get('Image URL')).toBe(cols.get('#')! + 1);
    }

    // Builder path: a real https URL renders as a clickable hyperlink cell.
    const buf = await buildPriceTemplateWorkbook(
      { id: 'SL-IMG', customerName: 'Acme', currencyCode: 'USD' },
      [{
        category: 'RAM', label: 'DIMM A', partNumber: 'TPL-A1', condition: null,
        qty: 2, imageUrl: 'https://static.recycleservers.com/label-scans/x.jpg',
        specs: { brand: 'Samsung', speed: 3200, chip: 'K4A8G085WB-BCTD' },
      }],
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const built = wb.worksheets[0];
    expect(built.getImages()).toHaveLength(0);
    const { row: headerRow, cols } = findHeaderRow(built);
    const cell = built.getRow(headerRow + 1).getCell(cols.get('Image URL')!);
    const v = cell.value as { text?: string; hyperlink?: string };
    expect(v?.hyperlink).toBe('https://static.recycleservers.com/label-scans/x.jpg');
    expect(v?.text).toBe('https://static.recycleservers.com/label-scans/x.jpg');
    expect(String(built.getRow(headerRow + 1).getCell(cols.get('Brand')!).value)).toBe('Samsung');
    expect(String(built.getRow(headerRow + 1).getCell(cols.get('Chip #')!).value)).toBe('K4A8G085WB-BCTD');
  });

  it('404s unknown orders and 403s non-managers', async () => {
    const mgr = await loginAs(ALEX);
    const missing = await getRaw('/api/sell-orders/SO-nope/price-template', mgr.token);
    expect(missing.status).toBe(404);

    const id = await createOrder(mgr.token);
    const pur = await loginAs(MARCUS);
    const forbidden = await getRaw(`/api/sell-orders/${id}/price-template`, pur.token);
    expect(forbidden.status).toBe(403);
  });
});

describe('GET /api/sell-orders/:id/packing-list', () => {
  beforeEach(async () => { await resetDb(); });

  // Every pack tab reserves the two RAM group-label columns, so the section
  // grid starts here whether or not the warehouse holds RAM.
  const PACK_OFFSET = 2;

  const cellStrings = (ws: ExcelJS.Worksheet): string[] => {
    const out: string[] = [];
    ws.eachRow(row => row.eachCell({ includeEmpty: false }, cell => {
      out.push(String(cell.value ?? ''));
    }));
    return out;
  };
  // Read a labelled row's numbers. The label sits at the first grid column,
  // not column A — the label columns are to its left.
  const rowQty = (ws: ExcelJS.Worksheet, firstCell: string): number[] => {
    const out: number[] = [];
    ws.eachRow(row => {
      if (String(row.getCell(1 + PACK_OFFSET).value ?? '') === firstCell) {
        row.eachCell({ includeEmpty: false }, cell => {
          if (typeof cell.value === 'number') out.push(cell.value);
        });
      }
    });
    return out;
  };

  it('streams price-free packing-checklist tabs, one per warehouse', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token, {
      lines: [
        { category: 'RAM', label: 'DIMM A', partNumber: 'WH-R1', qty: 2, unitPrice: 40, warehouseId: 'WH-LA1' },
        { category: 'RAM', label: 'DIMM A', partNumber: 'WH-R1', qty: 3, unitPrice: 40, warehouseId: 'WH-NJ2' },
        { category: 'SSD', label: 'Drive B', partNumber: 'WH-S1', qty: 1, unitPrice: 90, warehouseId: 'WH-LA1' },
      ],
    });
    const res = await getRaw(`/api/sell-orders/${id}/packing-list`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);
    expect(res.headers.get('content-disposition')).toContain('packing-list');

    const wb = await loadWorkbook(res);
    // Warehouse tabs only — the bid sheet is its own download.
    expect(wb.worksheets.map(w => w.name)).toEqual(['Pack - LA1', 'Pack - NJ2']);

    // LA1 holds both categories as stacked sections with qty subtotals and a
    // warehouse total; the NJ2 split stays on its own tab.
    const la1 = wb.worksheets.find(w => w.name === 'Pack - LA1')!;
    const la1Cells = cellStrings(la1);
    expect(la1Cells).toContain('RAM');
    expect(la1Cells).toContain('SSD');
    expect(la1Cells.filter(v => v === 'Packed ✓')).toHaveLength(2);
    expect(la1Cells.filter(v => v === 'Subtotal')).toHaveLength(2);
    expect(la1Cells).toContain('Warehouse total');
    expect(la1Cells).toContain('WH-R1');
    expect(la1Cells).toContain('WH-S1');
    // A picker packs by part number and spec, so the columns that only help a
    // bidder are off these tabs — headers and the values under them.
    for (const dropped of ['Item', 'Class', 'Chip #', 'Condition', 'Image URL']) {
      expect(la1Cells).not.toContain(dropped);
    }
    expect(la1Cells).not.toContain('DIMM A');
    expect(la1Cells).not.toContain('Drive B');
    // Price-free by design: nothing on a packing tab may look like a price —
    // that's also what keeps the import parser away from this workbook.
    expect(la1Cells.some(v => /price|单价|价格/i.test(v))).toBe(false);
    // Packing tabs ship unprotected — a picker types into the tick boxes.
    expect(la1.sheetProtection).toBeFalsy();

    // LA1: RAM qty 2 + SSD qty 1 → subtotals [2, 1], total 3. NJ2: RAM 3.
    expect(rowQty(la1, 'Subtotal')).toEqual([2, 1]);
    expect(rowQty(la1, 'Warehouse total')).toEqual([3]);

    const nj2 = wb.worksheets.find(w => w.name === 'Pack - NJ2')!;
    const nj2Cells = cellStrings(nj2);
    expect(nj2Cells).toContain('WH-R1');
    expect(nj2Cells).not.toContain('WH-S1');
    expect(rowQty(nj2, 'Warehouse total')).toEqual([3]);
  });

  it('is rejected outright when uploaded to the price import', async () => {
    // The parser needs a part header AND a price header on the same row; this
    // workbook has the first and never the second. Uploading the wrong file
    // must say so, not quietly match nothing.
    const { token } = await loginAs(ALEX);
    const id = await createOrder(token);
    const dl = await getRaw(`/api/sell-orders/${id}/packing-list`, token);
    const file = new Blob([await dl.arrayBuffer()], { type: XLSX_MIME });

    const res = await multipart(
      `/api/sell-orders/${id}/price-import/preview`, { file }, { token },
    );
    expect(res.status).toBe(400);
    expect((res.body as { code?: string }).code).toBe('columns-not-found');
  });

  it('404s unknown orders and 403s non-managers', async () => {
    const mgr = await loginAs(ALEX);
    const missing = await getRaw('/api/sell-orders/SO-nope/packing-list', mgr.token);
    expect(missing.status).toBe(404);

    const id = await createOrder(mgr.token);
    const pur = await loginAs(MARCUS);
    const forbidden = await getRaw(`/api/sell-orders/${id}/packing-list`, pur.token);
    expect(forbidden.status).toBe(403);
  });
});
