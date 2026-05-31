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

export async function buildXlsxBuffer(
  sheetName: string,
  columns: XlsxColumn[],
  rows: Record<string, unknown>[],
): Promise<Buffer> {
  // exceljs is a heavy dependency only needed by the rarely-hit export
  // endpoints — load it lazily so its cost isn't paid on every process boot.
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width ?? 16,
    style: col.numFmt ? { numFmt: col.numFmt } : {},
  }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) ws.addRow(r);
  if (columns.length > 0) {
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function xlsxResponse(buf: Buffer, filename: string): Response {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': XLSX_MIME,
      'Content-Disposition': `attachment; filename="${filename}"`,
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
