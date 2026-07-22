import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Workbook, Worksheet } from 'exceljs';
import app from '../src/index';
import { resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

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

async function loadWorkbook(res: Response): Promise<Workbook> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await res.arrayBuffer());
  return wb;
}

function rowStrings(ws: Worksheet, rowIdx: number): string[] {
  const vals = (ws.getRow(rowIdx).values as unknown[]) ?? [];
  return vals.map((v) => String(v ?? ''));
}

// The Summary sheet stacks per-category sections, so headers live mid-sheet.
// Section titles, Subtotal, and Order total all render in the FIRST cell of
// their row — match only that cell, since a data cell elsewhere can legally
// hold the same text (e.g. a condition of 'Other').
function findRowWithCell(ws: Worksheet, text: string): number {
  for (let i = 1; i <= ws.rowCount; i++) {
    if (String(ws.getRow(i).getCell(1).value ?? '') === text) return i;
  }
  return -1;
}

async function firstCustomerId(token: string): Promise<string> {
  const r = await api<{ items: { id: string }[] }>('GET', '/api/customers', { token });
  expect(r.status).toBe(200);
  expect(r.body.items.length).toBeGreaterThan(0);
  return r.body.items[0].id;
}

async function firstCustomerName(token: string): Promise<string> {
  const r = await api<{ items: { name: string }[] }>('GET', '/api/customers', { token });
  return r.body.items[0].name;
}

async function createSellOrder(token: string): Promise<string> {
  const line = await freeSellableLine(token, 1, new Set(), 'RAM');
  const customerId = await firstCustomerId(token);
  const r = await api<{ id: string }>('POST', '/api/sell-orders', {
    token,
    body: {
      customerId,
      lines: [{
        inventoryId: line.id, category: 'RAM', label: 'Sample DIMM',
        partNumber: 'PN-XLSX-1', qty: 2, unitPrice: line.sell_price,
        warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
      }],
    },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe('GET /api/sell-orders/:id/spreadsheet', () => {
  beforeEach(async () => { await resetDb(); });

  it('streams an xlsx workbook with a Summary tab plus one tab per category', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createSellOrder(token);

    const res = await getRaw(`/api/sell-orders/${id}/spreadsheet`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(XLSX_MIME);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('.xlsx');
    // Filename carries the customer name so downloads are scannable by who.
    const customerName = await firstCustomerName(token);
    expect(disposition).toContain(customerName.replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-'));

    const buf = Buffer.from(await res.arrayBuffer());
    // XLSX is a zip container — the magic bytes are 'PK'.
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(buf.length).toBeGreaterThan(500);

    const wb = await loadWorkbook(await getRaw(`/api/sell-orders/${id}/spreadsheet`, token));
    // A RAM-only order gets no empty SSD/HDD/Other tabs.
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'RAM']);
  });

  it('keeps a non-ASCII (Chinese) customer name in the download filename', async () => {
    const { token } = await loginAs(ALEX);
    const cnName = '深圳启航科技';
    const cust = await api<{ id: string }>('POST', '/api/customers', {
      token, body: { name: cnName },
    });
    expect(cust.status).toBe(201);

    const line = await freeSellableLine(token, 1, new Set(), 'RAM');
    const order = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId: cust.body.id,
        lines: [{
          inventoryId: line.id, category: 'RAM', label: 'Sample DIMM',
          partNumber: 'PN-CN-1', qty: 1, unitPrice: line.sell_price,
          warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
        }],
      },
    });
    expect(order.status).toBe(201);

    const res = await getRaw(`/api/sell-orders/${order.body.id}/spreadsheet`, token);
    expect(res.status).toBe(200);
    const disposition = res.headers.get('content-disposition') ?? '';
    // The \w-based slug used to strip every CJK character, dropping the customer
    // from the name entirely. The name now rides in the RFC 5987 filename*.
    expect(disposition).toContain(`filename*=UTF-8''`);
    expect(disposition).toContain(encodeURIComponent(cnName));
  });

  it('renders Price in native RMB for a CNY order', async () => {
    // Frankfurter is stubbed so the snapshot rate is deterministic.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ amount: 1, base: 'USD', date: '2026-06-07', rates: { CNY: 7.2154 } }),
      { status: 200 },
    )));
    try {
      const { token } = await loginAs(ALEX);
      const line = await freeSellableLine(token, 1, new Set(), 'RAM');
      const customerId = await firstCustomerId(token);
      const create = await api<{ id: string }>('POST', '/api/sell-orders', {
        token,
        body: {
          customerId,
          currency: 'CNY',
          lines: [{
            inventoryId: line.id, category: 'RAM', label: 'RMB DIMM',
            partNumber: 'PN-RMB-1', qty: 3, unitPrice: 78, warehouseId: 'WH-LA1',
          }],
        },
      });
      expect(create.status).toBe(201);

      const res = await getRaw(`/api/sell-orders/${create.body.id}/spreadsheet`, token);
      expect(res.status).toBe(200);

      const wb = await loadWorkbook(res);
      const ws = wb.getWorksheet('Summary')!;
      const titleRow = findRowWithCell(ws, 'RAM');
      expect(titleRow).toBeGreaterThan(0);
      const headers = rowStrings(ws, titleRow + 1);
      const priceCol = headers.indexOf('Avg price');
      const currencyCol = headers.indexOf('Currency');
      const totalCol = headers.indexOf('Total');
      expect(priceCol).toBeGreaterThan(0);

      const row = ws.getRow(titleRow + 2);
      // Native RMB price, not the ~10.81 USD conversion.
      expect(Number(row.getCell(priceCol).value)).toBe(78);
      expect(String(row.getCell(currencyCol).value)).toBe('CNY');
      expect(Number(row.getCell(totalCol).value)).toBe(234); // 3 × 78 RMB
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('omits cost/profit/internal columns from the workbook', async () => {
    const { token } = await loginAs(ALEX);
    const id = await createSellOrder(token);

    const res = await getRaw(`/api/sell-orders/${id}/spreadsheet`, token);
    expect(res.status).toBe(200);

    const wb = await loadWorkbook(res);
    // Internal/cost cells must not appear on any sheet, any row.
    for (const ws of wb.worksheets) {
      for (let i = 1; i <= ws.rowCount; i++) {
        const cells = rowStrings(ws, i);
        for (const gone of ['Unit cost', 'Sell price', 'Profit', 'Margin %', 'Submitted by', 'Status']) {
          expect(cells).not.toContain(gone);
        }
      }
    }

    // The Summary aggregates per part number, so per-line ID / Date / Warehouse
    // stay off it (they live on the detail tabs).
    const summary = wb.getWorksheet('Summary')!;
    const headers = rowStrings(summary, findRowWithCell(summary, 'RAM') + 1);
    for (const gone of ['ID', 'Date', 'Warehouse']) {
      expect(headers).not.toContain(gone);
    }
    for (const kept of ['Part #', 'Item', 'Spec', 'Qty', 'Avg price', 'Total', 'Currency', 'Image URL']) {
      expect(headers).toContain(kept);
    }
  });

  it('Summary groups by part number within a section and adds subtotal + order total', async () => {
    const { token } = await loginAs(ALEX);
    const customerId = await firstCustomerId(token);

    // Two hand-added lines (no inventory link, so the displayed Part # is the
    // line's own snapshot) sharing one part number but in different warehouses —
    // the RAM section should collapse them into a single row with Qty summed.
    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [
          { category: 'RAM', label: 'DIMM A', partNumber: 'PN-DUP', qty: 2, unitPrice: 10, warehouseId: 'WH-LA1' },
          { category: 'RAM', label: 'DIMM A', partNumber: 'PN-DUP', qty: 3, unitPrice: 10, warehouseId: 'WH-NJ2' },
        ],
      },
    });
    expect(create.status).toBe(201);

    const res = await getRaw(`/api/sell-orders/${create.body.id}/spreadsheet`, token);
    expect(res.status).toBe(200);

    const wb = await loadWorkbook(res);
    const ws = wb.getWorksheet('Summary')!;
    const titleRow = findRowWithCell(ws, 'RAM');
    const headers = rowStrings(ws, titleRow + 1);
    const partCol = headers.indexOf('Part #');
    const qtyCol = headers.indexOf('Qty');
    const totalCol = headers.indexOf('Total');

    // Exactly one data row for the single distinct part number…
    const dataRow = ws.getRow(titleRow + 2);
    expect(String(dataRow.getCell(partCol).value)).toBe('PN-DUP');
    expect(Number(dataRow.getCell(qtyCol).value)).toBe(5);       // 2 + 3
    expect(Number(dataRow.getCell(totalCol).value)).toBe(50);    // (2 + 3) × 10

    // …then a bold section subtotal, and an Order total after the spacer.
    const subtotalRow = ws.getRow(titleRow + 3);
    expect(rowStrings(ws, titleRow + 3)).toContain('Subtotal');
    expect(subtotalRow.font?.bold).toBe(true);
    expect(Number(subtotalRow.getCell(qtyCol).value)).toBe(5);
    expect(Number(subtotalRow.getCell(totalCol).value)).toBe(50);

    const orderTotalRow = findRowWithCell(ws, 'Order total');
    expect(orderTotalRow).toBeGreaterThan(titleRow + 3);
    const totals = rowStrings(ws, orderTotalRow);
    expect(totals).toContain('5');
    expect(totals).toContain('50');
  });

  it('splits a mixed order into per-category tabs with category-specific columns', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token, 1, new Set(), 'RAM');
    const customerId = await firstCustomerId(token);

    const create = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: {
        customerId,
        lines: [
          {
            inventoryId: line.id, category: 'RAM', label: 'Sample DIMM',
            partNumber: 'PN-MIX-RAM', qty: 1, unitPrice: line.sell_price,
            warehouseId: 'WH-LA1', condition: 'Pulled — Tested',
          },
          {
            category: 'SSD', label: 'Samsung 960GB', subLabel: 'SATA · 2.5in',
            partNumber: 'PN-MIX-SSD', qty: 2, unitPrice: 40, warehouseId: 'WH-LA1',
          },
          {
            category: 'Other', label: 'Rail kit', subLabel: '1U',
            partNumber: 'PN-MIX-OTH', qty: 3, unitPrice: 5,
          },
        ],
      },
    });
    expect(create.status).toBe(201);

    const res = await getRaw(`/api/sell-orders/${create.body.id}/spreadsheet`, token);
    expect(res.status).toBe(200);

    const wb = await loadWorkbook(res);
    // Fixed category order; no HDD tab for an order with no HDD lines.
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'RAM', 'SSD', 'Other']);

    // Specs stay composed into one Spec field (invSpec format); Chip # is the
    // one per-category column (RAM only). Category is the tab name, not a column.
    const ramHeaders = rowStrings(wb.getWorksheet('RAM')!, 1);
    for (const h of ['ID', 'Date', 'Item', 'Spec', 'Part #', 'Chip #', 'Warehouse', 'Condition', 'Qty', 'Price', 'Currency', 'Line total', 'Image URL']) {
      expect(ramHeaders).toContain(h);
    }
    for (const gone of ['Category', 'Brand', 'Gen', 'Class', 'Speed', 'Interface', 'Health %']) {
      expect(ramHeaders).not.toContain(gone);
    }

    const ssdHeaders = rowStrings(wb.getWorksheet('SSD')!, 1);
    for (const h of ['Item', 'Spec', 'Part #']) {
      expect(ssdHeaders).toContain(h);
    }
    for (const gone of ['Chip #', 'Interface', 'Form factor', 'Health %']) {
      expect(ssdHeaders).not.toContain(gone);
    }

    // Detail tabs keep the frozen bold header of the flat sheets.
    expect(wb.getWorksheet('RAM')!.views[0]?.ySplit).toBe(1);

    // Summary stacks the sections in the same fixed order.
    const summary = wb.getWorksheet('Summary')!;
    const ramTitle = findRowWithCell(summary, 'RAM');
    const ssdTitle = findRowWithCell(summary, 'SSD');
    const otherTitle = findRowWithCell(summary, 'Other');
    expect(ramTitle).toBeGreaterThan(0);
    expect(ssdTitle).toBeGreaterThan(ramTitle);
    expect(otherTitle).toBeGreaterThan(ssdTitle);

    // A manual line has no inventory row: Item/Spec carry the line's own
    // label/sub_label snapshot.
    const ssdWs = wb.getWorksheet('SSD')!;
    const itemCol = ssdHeaders.indexOf('Item');
    const specCol = ssdHeaders.indexOf('Spec');
    const partCol = ssdHeaders.indexOf('Part #');
    const whCol = ssdHeaders.indexOf('Warehouse');
    const dataRow = ssdWs.getRow(2);
    expect(String(dataRow.getCell(itemCol).value)).toBe('Samsung 960GB');
    expect(String(dataRow.getCell(specCol).value)).toBe('SATA · 2.5in');
    expect(String(dataRow.getCell(partCol).value)).toBe('PN-MIX-SSD');
    expect(String(dataRow.getCell(whCol).value)).not.toBe('');

    const otherWs = wb.getWorksheet('Other')!;
    const otherHeaders = rowStrings(otherWs, 1);
    const otherItemCol = otherHeaders.indexOf('Item');
    const otherSpecCol = otherHeaders.indexOf('Spec');
    expect(String(otherWs.getRow(2).getCell(otherItemCol).value)).toBe('Rail kit');
    expect(String(otherWs.getRow(2).getCell(otherSpecCol).value)).toBe('1U');
  });

  it('404s an unknown sell order', async () => {
    const { token } = await loginAs(ALEX);
    const res = await getRaw('/api/sell-orders/SO-does-not-exist/spreadsheet', token);
    expect(res.status).toBe(404);
  });

  it('forbids a non-manager', async () => {
    const mgr = await loginAs(ALEX);
    const id = await createSellOrder(mgr.token);

    const pur = await loginAs(MARCUS);
    const res = await getRaw(`/api/sell-orders/${id}/spreadsheet`, pur.token);
    expect(res.status).toBe(403);
  });
});
