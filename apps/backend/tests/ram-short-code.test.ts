import { beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { ramShortCode, ramShortCodes } from '@recycle-erp/shared';
import app from '../src/index';
import { foldSheetLines, type SheetLineRow } from '../src/services/sellOrderNumbers';
import { readPriceSheetRows } from '../src/services/priceSheet';
import { api, multipart, testEnv } from './helpers/app';
import { getTestDb, resetDb } from './helpers/db';
import { ALEX, loginAs } from './helpers/auth';

describe('RAM market short codes', () => {
  it.each([
    ['Samsung', 'M393A2G40DB0-CPB0Q', 'DB0'],
    ['Samsung', 'M393A4K40DB3-CWE', 'DB3'],
    ['Samsung', 'M471A2K43CB1-CTD', 'CB1'],
    ['Samsung', 'M321R4GA3BB6-CQKET', 'BB6'],
    ['SK Hynix', 'HMA42GR7MFR4N-TF', 'MFR'],
    ['SK Hynix', 'HMA82GR7CJR8N-VK-TF', 'CJR'],
    ['SK Hynix', 'HMT351R7BFR8C-H9', 'BFR'],
  ])('%s %s → %s, with or without separators', (brand, partNumber, code) => {
    expect(ramShortCode({ brand, partNumber })).toBe(code);
    expect(ramShortCode({ brand: ` ${brand.toLowerCase()} `, partNumber: `P/N: ${partNumber.toLowerCase().replaceAll('-', '')}` })).toBe(code);
  });

  it.each(['VPP', 'd9vpp', '8KE75 D9VPP'])('uses the recorded Micron chip %s', chipNumber => {
    expect(ramShortCode({ brand: 'Micron', chipNumber })).toBe('VPP');
  });

  it.each(['', 'DDR5', 'NA', 'MICRON CHIP', '1HR75D8PJ'])('keeps unknown Micron marking %s unknown', chipNumber => {
    expect(ramShortCode({ brand: 'Micron', partNumber: 'MTA16ATF2G64HZ-3G2J1', chipNumber })).toBeNull();
  });

  it.each([
    { brand: 'Samsung', partNumber: 'ABC-DEF' },
    { brand: 'Samsung', partNumber: 'M393A2G40DB' },
    { brand: 'SK Hynix', partNumber: 'HMCG88MEBRA-084N' },
    { brand: 'Other', partNumber: 'M393A2G40DB0-CPB0Q' },
    { brand: 'Samsung', partNumber: 'HMA42GR7MFR4N-TF' },
    {},
  ])('does not invent a code for $partNumber', row => {
    expect(ramShortCode(row)).toBeNull();
  });

  it('retains distinct dies and an unknown lot within one part-number group', () => {
    expect(ramShortCodes(['VPP', 'WSM', 'VPP', null].map(chipNumber => ({ brand: 'Micron', chipNumber })))).toEqual(['VPP', 'WSM', null]);
  });
});

function bidLot(n: number, patch: Partial<SheetLineRow> = {}): SheetLineRow {
  return {
    sol_id: `sale-${n}`, sell_qty: n, sol_label: 'Samsung 16GB DDR4', sol_sub: null,
    sol_part: null, sol_category: 'RAM', sol_condition: null, product_no: n,
    append_batch: 0, pack_warehouse: `WH-${n}`, inv_id: `lot-${n}`,
    source_order_id: `PO-${n}`, po_line_no: 1,
    category: 'RAM', brand: 'Samsung', capacity: '16GB', generation: 'DDR4',
    type: 'Server', classification: 'RDIMM', rank: '2Rx4', speed: '2133',
    interface: null, form_factor: null, description: null,
    part_number: `M393A2G40DB0-CPB${n}Q`, chip_number: null,
    condition: 'Pulled — Tested', health: null, rpm: null, image_url: null,
    ...patch,
  };
}

describe('RAM bid groups', () => {
  it('combines module numbers and warehouses, sums quantity, and keeps packing products numbered separately', () => {
    const { products, warehouses } = foldSheetLines([bidLot(1), bidLot(2)], 3);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ qty: 3, specs: { shortCode: 'DB0' } });
    expect(products[0].partNumber).toBe('M393A2G40DB0-CPB1Q, M393A2G40DB0-CPB2Q');
    expect(warehouses.flatMap(w => w.products).map(p => p.no).sort()).toEqual([1, 2]);
  });

  it.each([
    { speed: '2400' }, { rank: '1Rx4' }, { capacity: '32GB' },
    { generation: 'DDR5' }, { type: 'Desktop' }, { classification: 'LRDIMM' },
    { part_number: 'M393A2G40DB1-CPB' },
  ])('keeps a different spec/code separate: %j', patch => {
    expect(foldSheetLines([bidLot(1), bidLot(2, patch)], 3).products).toHaveLength(2);
  });

  it('keeps brands separate even when their short codes match', () => {
    expect(foldSheetLines([
      bidLot(1, { part_number: 'M393A2G40MFR-CPB' }),
      bidLot(2, { brand: 'Micron', part_number: 'MTA18ASF2G72PDZ-2G1A1', chip_number: 'MFR' }),
    ], 3).products).toHaveLength(2);
  });

  it('recognizes equivalent speed spellings', () => {
    expect(foldSheetLines([bidLot(1, { speed: '2400' }), bidLot(2, { speed: 'PC4-19200' })], 3).products).toHaveLength(1);
  });

  it('excludes zero-quantity module numbers from a live bid group', () => {
    const { products } = foldSheetLines([bidLot(1, { sell_qty: 0 }), bidLot(2)], 3);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ qty: 2, partNumber: 'M393A2G40DB0-CPB2Q' });
  });

  it('keeps incomplete specs on their prior grouping', () => {
    expect(foldSheetLines([bidLot(1, { rank: null }), bidLot(2, { rank: null })], 3).products).toHaveLength(2);
  });
});

const PN = 'MTA16ATF2G64HZ-3G2J1';
type Lot = { id: string; partNumber: string; chipNumber: string | null };

async function stock(token: string, paypalTxnId = 'SHORTCODETXN00001'): Promise<{ id: string; lots: Lot[] }> {
  const made = await api<{ id: string }>('POST', '/api/orders', { token, body: {
    warehouseId: 'WH-LA1', paypalTxnId, category: 'RAM',
    lines: ['VPP', 'WSM', null].map(chipNumber => ({
      category: 'RAM', brand: 'Micron', capacity: '16GB', generation: 'DDR4', type: 'Laptop',
      classification: 'SODIMM', rank: '2Rx8', speed: '3200', partNumber: PN, chipNumber,
      qty: 1, unitCost: 10, condition: 'Pulled — Tested',
    })),
  }});
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  for (let i = 0; i < 2; i++) expect((await api('POST', `/api/orders/${made.body.id}/advance`, { token })).status).toBe(200);
  const detail = await api<{ order: { lines: Lot[] } }>('GET', `/api/orders/${made.body.id}`, { token });
  return { id: made.body.id, lots: detail.body.order.lines };
}

async function workbook(path: string, token: string): Promise<ExcelJS.Workbook> {
  const response = await app.fetch(new Request('http://test' + path, { headers: { cookie: `at=${token}` } }), testEnv);
  expect(response.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await response.arrayBuffer());
  return wb;
}

function table(ws: ExcelJS.Worksheet, header: string) {
  for (let r = 1; r <= 15; r++) {
    const headers = ws.getRow(r).values as unknown[];
    if (headers.includes(header)) return { row: r, col: (name: string) => headers.indexOf(name) };
  }
  throw new Error('No header found');
}

describe('short codes from existing RAM stock', () => {
  beforeEach(async () => { await resetDb(); });

  it('shows each die and unknown lot, and recording a chip updates its code with an audit', async () => {
    const { token } = await loginAs(ALEX);
    const { id, lots } = await stock(token);
    const flat = await api<{ items: { id: string; short_code: string | null }[] }>('GET', `/api/inventory?q=${PN}`, { token });
    expect(flat.body.items.map(l => l.short_code).sort()).toEqual(['VPP', 'WSM', null].sort());
    const grouped = await api<{ products: { short_codes: (string | null)[]; lines: { short_code: string | null }[] }[] }>('GET', `/api/inventory/products?q=${PN}`, { token });
    expect(grouped.body.products).toHaveLength(1);
    expect(grouped.body.products[0].short_codes).toEqual(['VPP', 'WSM', null]);
    expect(grouped.body.products[0].lines.map(l => l.short_code).sort()).toEqual(flat.body.items.map(l => l.short_code).sort());

    const blank = lots.find(l => !l.chipNumber)!;
    expect((await api('PATCH', `/api/inventory/${blank.id}`, { token, body: { chipNumber: '8KE75 D9VPP' } })).status).toBe(200);
    const detail = await api<{ item: { chip_number: string; short_code: string }; events: { detail: unknown }[] }>('GET', `/api/inventory/${blank.id}`, { token });
    expect(detail.body.item).toMatchObject({ chip_number: 'VPP', short_code: 'VPP' });
    expect(detail.body.events.map(e => e.detail)).toContainEqual({ field: 'chipNumber', from: null, to: 'VPP' });
    const order = await api<{ order: { lifecycle: string } }>('GET', `/api/orders/${id}`, { token });
    expect(order.body.order.lifecycle).toBe('reviewing');
    expect((await api('PATCH', `/api/inventory/${blank.id}`, { token, body: { chipNumber: null } })).status).toBe(200);
    const cleared = await api<{ item: { short_code: null } }>('GET', `/api/inventory/${blank.id}`, { token });
    expect(cleared.body.item.short_code).toBeNull();
  });

  it('aggregates DDR5 codes and scopes them to the warehouse shown', async () => {
    const { token } = await loginAs(ALEX);
    const { lots } = await stock(token);
    const sql = getTestDb();
    await sql`UPDATE order_lines SET brand = 'Samsung', generation = 'DDR5',
      type = 'Server', classification = 'RDIMM', rank = '2Rx4', speed = '4800',
      part_number = 'M321R4GA3BB6-CQK', warehouse_id = 'WH-LA1' WHERE id = ${lots[0].id}`;
    await sql`UPDATE order_lines SET brand = 'Samsung', generation = 'DDR5',
      type = 'Server', classification = 'RDIMM', rank = '2Rx4', speed = '4800',
      part_number = 'M321R4GA3PB3-CQK', warehouse_id = 'WH-NJ2' WHERE id = ${lots[1].id}`;
    const groups = async (warehouse: string) => (await api<{ products: { short_codes: string[]; qty: number }[] }>(
      'GET', `/api/inventory/products?q=M321R4GA3${warehouse}`, { token })).body.products;
    expect(await groups('')).toMatchObject([{ short_codes: ['BB6', 'PB3'], qty: 2 }]);
    expect(await groups('&warehouse=WH-LA1')).toMatchObject([{ short_codes: ['BB6'], qty: 1 }]);
  });

  it('exports per-lot codes and distinct grouped codes without changing quantities', async () => {
    const { token } = await loginAs(ALEX);
    await stock(token);
    for (const grouped of [false, true]) {
      const wb = await workbook(`/api/inventory/export?q=${PN}${grouped ? '&view=grouped' : ''}`, token);
      const ws = wb.getWorksheet('RAM')!;
      const { row, col } = table(ws, 'Short code');
      const codes: string[] = [];
      let qty = 0;
      for (let r = row + 1; r <= ws.rowCount; r++) {
        if (!ws.getRow(r).getCell(col('Part #')).value) continue;
        codes.push(String(ws.getRow(r).getCell(col('Short code')).value ?? ''));
        qty += Number(ws.getRow(r).getCell(col('Qty')).value);
      }
      expect(codes.sort()).toEqual(grouped ? ['VPP, WSM, —'] : ['', 'VPP', 'WSM']);
      expect(qty).toBe(3);
    }
  });

  it('sums matching bid lots and imports each die price for every listed part', async () => {
    const { token } = await loginAs(ALEX);
    const first = await stock(token);
    const second = await stock(token, 'SHORTCODETXN00002');
    const variant = 'MTA16ATF2G64HZ-3G2E1';
    const changed = second.lots.find(l => l.chipNumber === 'VPP')!;
    await getTestDb()`UPDATE order_lines SET part_number = ${variant} WHERE id = ${changed.id}`;
    changed.partNumber = variant;
    const lots = [...first.lots, ...second.lots];
    const customers = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
    const made = await api<{ id: string }>('POST', '/api/sell-orders', { token, body: {
      customerId: customers.body.items[0].id,
      lines: lots.map(l => ({ inventoryId: l.id, category: 'RAM', label: 'Micron 16GB DDR4', partNumber: l.partNumber, qty: 1, unitPrice: 20 })),
    }});
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const detail = await api<{ order: { lines: { shortCode: string | null }[] } }>('GET', `/api/sell-orders/${made.body.id}`, { token });
    expect(detail.body.order.lines.map(l => l.shortCode).sort()).toEqual(['VPP', 'VPP', 'WSM', 'WSM', null, null].sort());
    const wb = await workbook(`/api/sell-orders/${made.body.id}/price-template`, token);
    const ws = wb.getWorksheet('RAM')!;
    const { row, col } = table(ws, 'Part Number');
    const prices = new Map<string | null, number>([['VPP', 25], ['WSM', 30], [null, 35]]);
    const codes: string[] = [];
    for (let r = row + 1; r <= ws.rowCount; r++) {
      const data = ws.getRow(r);
      if (!data.getCell(col('Part Number')).value) continue;
      const code = String(data.getCell(col('Short code')).value);
      codes.push(code);
      expect(data.getCell(col('Qty')).value).toBe(2);
      if (code === 'VPP') expect(String(data.getCell(col('Part Number')).value).split(', ').sort()).toEqual([PN, variant].sort());
      data.getCell(col('Unit Price (USD)')).value = prices.get(code === '—' ? null : code)!;
    }
    expect(codes.sort()).toEqual(['VPP', 'WSM', '—']);
    const bytes = await wb.xlsx.writeBuffer();
    const imported = new ExcelJS.Workbook();
    await imported.xlsx.load(bytes);
    const parsed = readPriceSheetRows(imported);
    expect(parsed).toHaveLength(4);
    expect(parsed).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawPart: PN, shortCodes: ['VPP'], price: 25 }),
      expect.objectContaining({ rawPart: variant, shortCodes: ['VPP'], price: 25 }),
      expect.objectContaining({ rawPart: PN, shortCodes: ['WSM'], price: 30 }),
      expect.objectContaining({ rawPart: PN, shortCodes: [null], price: 35 }),
    ]));
    for (const po of [first, second]) {
      const preview = await multipart(`/api/orders/${po.id}/price-sheet/preview`, {
        file: new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
        currency: 'USD',
      }, { token });
      expect(preview.status).toBe(200);
      const body = preview.body as { lines: { lineId: string; status: string; cell: { price: number } }[] };
      for (const lot of po.lots) expect(body.lines.find(l => l.lineId === lot.id)).toMatchObject({
        status: 'matched', cell: { price: prices.get(lot.chipNumber) },
      });
    }
  });
});
