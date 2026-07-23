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
};

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
    const ws = wb.addWorksheet(name);
    ws.columns = sheet.columns.map((col) => ({
      header: col.header,
      key: col.key,
      width: col.width ?? 16,
      style: col.numFmt ? { numFmt: col.numFmt } : {},
    }));
    // Styled header band (same dark slate as the sell-order bid sheet) +
    // zebra-striped data rows, so every export reads as one designed set.
    const header = ws.getRow(1);
    header.height = 22;
    for (let cIdx = 1; cIdx <= sheet.columns.length; cIdx++) {
      const cell = header.getCell(cIdx);
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
      cell.alignment = { vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: 'FF111827' } } };
    }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of sheet.rows) {
      const row = ws.addRow(r);
      if (row.number % 2 === 1) {
        // Odd sheet rows are even data rows (row 1 is the header).
        for (let cIdx = 1; cIdx <= sheet.columns.length; cIdx++) {
          row.getCell(cIdx).fill = {
            type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' },
          };
        }
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
