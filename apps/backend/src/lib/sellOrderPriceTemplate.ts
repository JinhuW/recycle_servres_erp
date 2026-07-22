// Vendor bid sheet for one sell order: a styled workbook the manager emails
// out and the vendor fills in. Built directly with exceljs rather than
// lib/xlsx.ts — the flat sheet builder there has no notion of merged
// instruction rows, embedded images, per-cell protection, or formulas.
//
// Everything except the Unit Price column is locked; the import parser still
// never relies on that structure (it re-locates columns by header text).

import sharp from 'sharp';
import type ExcelJS from 'exceljs';
import { getAttachmentBytes } from '../r2';
import type { Env } from '../types';

export type PriceTemplateThumbnail = {
  data: Buffer;
  width: number;
  height: number;
};

export type PriceTemplateProduct = {
  label: string;
  subLabel: string | null;
  partNumber: string | null;
  condition: string | null;
  qty: number;
  thumbnail: PriceTemplateThumbnail | null;
};

export type PriceTemplateHead = {
  id: string;
  customerName: string;
  currencyCode: string;
};

// Rendered at half resolution so photos stay crisp on hi-DPI screens.
const THUMB_SOURCE_PX = 192;
const THUMB_DISPLAY_MAX_PX = 96;

export async function makePriceTemplateThumbnail(
  bytes: Buffer,
): Promise<PriceTemplateThumbnail | null> {
  try {
    const { data, info } = await sharp(bytes)
      .rotate()
      .resize({
        width: THUMB_SOURCE_PX,
        height: THUMB_SOURCE_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 70 })
      .toBuffer({ resolveWithObject: true });
    const scale = Math.min(1, THUMB_DISPLAY_MAX_PX / Math.max(info.width, info.height));
    return {
      data,
      width: Math.max(1, Math.round(info.width * scale)),
      height: Math.max(1, Math.round(info.height * scale)),
    };
  } catch {
    return null;
  }
}

// Bytes for a label scan, best-effort. The S3 key is the fast path, but dev
// databases are nightly copies of prod: their keys point at the PROD bucket,
// which this environment's credentials can't read. The scan's stored absolute
// delivery_url still resolves publicly, so it is the fallback — it also covers
// legacy scans whose ids predate the R2 migration.
const SCAN_FETCH_MAX_BYTES = 20 * 1024 * 1024;

export async function fetchScanBytes(
  env: Env,
  storageKey: string | null,
  deliveryUrl: string | null,
): Promise<Buffer | null> {
  if (storageKey) {
    const bytes = await getAttachmentBytes(env, storageKey);
    if (bytes) return bytes;
  }
  if (!deliveryUrl || !/^https:\/\//i.test(deliveryUrl)) return null;
  try {
    const res = await fetch(deliveryUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > SCAN_FETCH_MAX_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

const HEADER_ROW = 5;
const COLS = { index: 1, photo: 2, item: 3, detail: 4, part: 5, condition: 6, qty: 7, price: 8, total: 9 };

const BAND_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } } as const;
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } } as const;
const PRICE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7C2' } } as const;

export async function buildPriceTemplateWorkbook(
  head: PriceTemplateHead,
  products: PriceTemplateProduct[],
): Promise<Buffer> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Price Sheet', {
    views: [{ state: 'frozen', ySplit: HEADER_ROW }],
  });
  ws.columns = [
    { width: 5 }, { width: 14 }, { width: 34 }, { width: 28 }, { width: 24 },
    { width: 18 }, { width: 8 }, { width: 16 }, { width: 14 },
  ];

  const cur = head.currencyCode;
  const currencyLabel = cur === 'CNY' ? '人民币 CNY' : 'USD';

  ws.mergeCells(1, 1, 1, COLS.total);
  const band = ws.getCell(1, 1);
  band.value = `Recycle Servers · Sell Order ${head.id} — ${head.customerName}`;
  band.fill = BAND_FILL;
  band.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  band.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 30;

  ws.mergeCells(2, 1, 2, COLS.total);
  const instr = ws.getCell(2, 1);
  // Always bilingual: the backend has no per-user i18n and CNY-order vendors
  // are typically Chinese-speaking.
  instr.value =
    `Fill ONLY the highlighted "Unit Price (${cur})" column, in ${currencyLabel}. ` +
    `Do not edit other cells. / 请只在高亮的 "Unit Price (${cur})" 列填写单价（${currencyLabel}），请勿修改其他内容。`;
  instr.font = { size: 11 };
  instr.alignment = { vertical: 'middle', wrapText: true };
  ws.getRow(2).height = 32;

  ws.getCell(3, 1).value = `Generated ${new Date().toISOString().slice(0, 10)}`;
  ws.getCell(3, 1).font = { size: 10, color: { argb: 'FF6B7280' } };

  const headers: [number, string][] = [
    [COLS.index, '#'], [COLS.photo, 'Photo'], [COLS.item, 'Item'], [COLS.detail, 'Detail'],
    [COLS.part, 'Part Number'], [COLS.condition, 'Condition'], [COLS.qty, 'Qty'],
    [COLS.price, `Unit Price (${cur})`], [COLS.total, `Line Total (${cur})`],
  ];
  const headerRow = ws.getRow(HEADER_ROW);
  for (const [col, text] of headers) {
    const cell = headerRow.getCell(col);
    cell.value = text;
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.border = { bottom: { style: 'medium' } };
  }

  products.forEach((p, i) => {
    const r = HEADER_ROW + 1 + i;
    const row = ws.getRow(r);
    row.getCell(COLS.index).value = i + 1;
    row.getCell(COLS.item).value = p.label;
    row.getCell(COLS.detail).value = p.subLabel ?? '';
    row.getCell(COLS.part).value = p.partNumber ?? '';
    row.getCell(COLS.condition).value = p.condition ?? '';
    const qtyCell = row.getCell(COLS.qty);
    qtyCell.value = p.qty;
    qtyCell.numFmt = '#,##0';

    // Blank bid cell: existing order prices must not leak to the vendor.
    const priceCell = row.getCell(COLS.price);
    priceCell.numFmt = '#,##0.00';
    priceCell.fill = PRICE_FILL;
    priceCell.protection = { locked: false };

    const totalCell = row.getCell(COLS.total);
    const qtyRef = `${ws.getColumn(COLS.qty).letter}${r}`;
    const priceRef = `${ws.getColumn(COLS.price).letter}${r}`;
    totalCell.value = { formula: `${qtyRef}*${priceRef}` };
    totalCell.numFmt = '#,##0.00';

    row.alignment = { vertical: 'middle' };
    if (p.thumbnail) {
      // exceljs ships its own Buffer alias that predates Node's generic Buffer.
      const imgId = wb.addImage({
        buffer: p.thumbnail.data as unknown as ExcelJS.Buffer,
        extension: 'jpeg',
      });
      // tl is zero-based; nudge off the cell edge so borders stay visible.
      ws.addImage(imgId, {
        tl: { col: COLS.photo - 1 + 0.05, row: r - 1 + 0.05 },
        ext: { width: p.thumbnail.width, height: p.thumbnail.height },
      });
      // Row height is in points (~0.75 px) — size for the display box.
      row.height = Math.max(20, Math.round(p.thumbnail.height * 0.78));
    }
  });

  // Guard rail, not security: the manager can lift it in Excel (no password),
  // and the import parser tolerates a vendor who does.
  await ws.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatCells: false,
    formatColumns: false,
    formatRows: false,
    insertRows: false,
    deleteRows: false,
    sort: false,
    autoFilter: false,
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
