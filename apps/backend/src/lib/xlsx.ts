// Shared workbook builder for the desktop "Export" buttons. Generation lives on
// the backend because the list endpoints cap their JSON payloads (inventory is
// LIMIT 200) — a browser-side export off the visible rows would silently
// truncate. Columns carry an optional Excel number format so currency/qty land
// as real numbers, not strings.
export type XlsxColumn = {
  header: string;
  key: string;
  width?: number;
  numFmt?: string;
};

export type XlsxSheet = {
  name: string;
  columns: XlsxColumn[];
  rows: Record<string, unknown>[];
  // ARGB tint for the sheet tab, so a multi-tab workbook is navigable from the
  // sheet strip alone. See lib/specColumns.ts for the assigned hues.
  tabColor?: string;
};

// Money reads as money everywhere: two decimals, thousands separators, and
// negatives in red so a loss-making line can't hide in a column of black
// numbers. Percentages get the same signed treatment at one decimal.
export const MONEY_FMT = '#,##0.00';
export const SIGNED_MONEY_FMT = '#,##0.00;[Red]-#,##0.00';
export const SIGNED_PCT_FMT = '#,##0.0;[Red]-#,##0.0';

// Workbook palette. Every download the app emits — inventory, purchase orders,
// sell orders — is styled from these, so the set reads as one designed family.
// Excel gridlines are switched off and replaced by the hairline row rule below:
// with the zebra banding doing the row tracking, the visible grid only adds
// noise, and the result reads as a report rather than a raw dump.
export const INK = 'FF16233A';   // header band (shared with the bid sheet)
const INK_EDGE = 'FF0B7A62';     // brand emerald rule under the band
const STRIPE = 'FFF5F7FA';       // zebra row
const MONEY_TINT = 'FFF2F9F5';   // money column, plain row
const MONEY_STRIPE = 'FFE9F3EC'; // money column, zebra row
const HAIRLINE = 'FFE3E8EF';     // row separator

const solid = (argb: string) =>
  ({ type: 'pattern', pattern: 'solid', fgColor: { argb } }) as const;

const STRIPE_FILL = solid(STRIPE);
const MONEY_FILL = solid(MONEY_TINT);
const MONEY_STRIPE_FILL = solid(MONEY_STRIPE);
const ROW_RULE = { bottom: { style: 'hair', color: { argb: HAIRLINE } } } as const;

// Excel forbids \ / ? * : [ ] in tab names and caps them at 31 chars. Warehouse
// codes are clean, but sanitize anyway so a future odd code can't corrupt the
// workbook.
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*:[\]]/g, ' ').trim().slice(0, 31);
  return cleaned || 'Sheet';
}

export async function buildXlsxWorkbook(sheets: XlsxSheet[]): Promise<Buffer> {
  // exceljs is a heavy dependency only needed by the rarely-hit export
  // endpoints — load it lazily so its cost isn't paid on every process boot.
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  // Two tabs can't share a name; suffix collisions so a duplicate warehouse
  // code (or one sanitized into another) can't throw mid-write.
  const used = new Map<string, number>();
  for (const sheet of sheets) {
    let name = safeSheetName(sheet.name);
    const seen = used.get(name);
    if (seen != null) {
      used.set(name, seen + 1);
      name = safeSheetName(`${name} ${seen + 1}`);
    } else {
      used.set(name, 1);
    }
    const ws = wb.addWorksheet(name, {
      properties: sheet.tabColor ? { tabColor: { argb: sheet.tabColor } } : {},
      views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
      // These workbooks get printed and PDF'd for suppliers. Landscape, scaled
      // to one page wide, with the header repeated on every sheet of paper —
      // otherwise page 2 onward is a wall of unlabelled numbers.
      pageSetup: {
        orientation: 'landscape',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        printTitlesRow: '1:1',
        margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
      },
    });
    ws.columns = sheet.columns.map((col) => ({
      header: col.header,
      key: col.key,
      width: col.width ?? 16,
      style: col.numFmt ? { numFmt: col.numFmt } : {},
    }));
    // A number column's header sits over right-aligned digits, so right-align
    // it too — a left-hugging "Unit cost" over a right-hugging column of money
    // is the single thing that makes a wide sheet look unmade.
    const header = ws.getRow(1);
    header.height = 26;
    for (let cIdx = 1; cIdx <= sheet.columns.length; cIdx++) {
      const cell = header.getCell(cIdx);
      cell.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
      cell.fill = solid(INK);
      cell.alignment = {
        vertical: 'middle',
        horizontal: sheet.columns[cIdx - 1].numFmt ? 'right' : 'left',
        wrapText: true,
      };
      cell.border = { bottom: { style: 'medium', color: { argb: INK_EDGE } } };
    }
    // Cost/price/profit columns carry a faint emerald wash so the money block
    // separates from the spec block at a glance. Detected off the decimal
    // format rather than a per-column flag, so any new money column inherits it
    // for free — and integer counts (Qty, RPM, Health %) stay untinted.
    const isMoney = sheet.columns.map((col) => !!col.numFmt?.includes('0.00'));
    for (const r of sheet.rows) {
      const row = ws.addRow(r);
      // Odd sheet rows are even data rows (row 1 is the header).
      const striped = row.number % 2 === 1;
      for (let cIdx = 1; cIdx <= sheet.columns.length; cIdx++) {
        const cell = row.getCell(cIdx);
        if (isMoney[cIdx - 1]) cell.fill = striped ? MONEY_STRIPE_FILL : MONEY_FILL;
        else if (striped) cell.fill = STRIPE_FILL;
        cell.border = ROW_RULE;
      }
    }
    if (sheet.columns.length > 0) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
    }
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

export function buildXlsxBuffer(
  sheetName: string,
  columns: XlsxColumn[],
  rows: Record<string, unknown>[],
): Promise<Buffer> {
  return buildXlsxWorkbook([{ name: sheetName, columns, rows }]);
}

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// A Content-Disposition that survives non-ASCII names (Chinese customers): an
// ASCII fallback for legacy clients plus an RFC 5987 filename* carrying the
// UTF-8 name. Without filename*, a raw CJK name is mangled or dropped by the
// HTTP layer. encodeURIComponent leaves a few chars RFC 5987 reserves (notably
// the ' that delimits the field) — escape those too.
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*!]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function xlsxResponse(buf: Buffer, filename: string): Response {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': contentDisposition(filename),
      'Content-Length': String(buf.length),
    },
  });
}

// `inventory-2026-05-29.xlsx` — date suffix keeps repeat exports distinct in the
// downloads folder without a counter.
export function datedFilename(base: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${base}-${day}.xlsx`;
}
