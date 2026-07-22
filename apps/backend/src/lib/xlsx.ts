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

// A sheet made of stacked sub-tables ("sections"), each with its own title,
// header row, and column set — used when one flat header can't fit rows of
// different shapes (e.g. the sell-order Summary mixing RAM and SSD spec
// columns). Sectioned sheets get no autoFilter or frozen header: both bind to
// a single header row, which this layout doesn't have.
export type XlsxSection = {
  title: string;
  columns: XlsxColumn[];
  rows: Record<string, unknown>[];
  // Optional bold trailing row (e.g. per-section subtotal); keys align to
  // `columns`, absent keys render blank.
  subtotal?: Record<string, unknown>;
};

export type XlsxSectionedSheet = {
  name: string;
  sections: XlsxSection[];
  // Optional bold grand-total row appended after a blank spacer. `totalColumns`
  // supplies its key→cell placement and number formats (sections may disagree
  // on column meaning by index, so the total declares its own layout).
  total?: Record<string, unknown>;
  totalColumns?: XlsxColumn[];
};

// Excel forbids \ / ? * : [ ] in tab names and caps them at 31 chars. Warehouse
// codes are clean, but sanitize anyway so a future odd code can't corrupt the
// workbook.
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*:[\]]/g, ' ').trim().slice(0, 31);
  return cleaned || 'Sheet';
}

// Sectioned sheets never set `ws.columns` (that would write a header row and
// pin one key set), so rows are appended positionally and numFmt is applied
// per cell — column-level styles can't work when header sets differ per
// section.
function addKeyedRow(
  ws: import('exceljs').Worksheet,
  columns: XlsxColumn[],
  values: Record<string, unknown>,
  bold: boolean,
): void {
  const row = ws.addRow(columns.map((c) => values[c.key] ?? ''));
  if (bold) row.font = { bold: true };
  columns.forEach((c, i) => {
    if (c.numFmt) row.getCell(i + 1).numFmt = c.numFmt;
  });
}

function renderSectionedSheet(
  ws: import('exceljs').Worksheet,
  sheet: XlsxSectionedSheet,
): void {
  // Column widths are shared per index across all sections; take the widest so
  // no section's cells get clipped.
  const widths: number[] = [];
  const widen = (cols: XlsxColumn[]) =>
    cols.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.width ?? 16);
    });
  for (const sec of sheet.sections) widen(sec.columns);
  if (sheet.totalColumns) widen(sheet.totalColumns);
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  let first = true;
  for (const sec of sheet.sections) {
    if (!first) ws.addRow([]);
    first = false;
    ws.addRow([sec.title]).font = { bold: true };
    ws.addRow(sec.columns.map((c) => c.header)).font = { bold: true };
    for (const r of sec.rows) addKeyedRow(ws, sec.columns, r, false);
    if (sec.subtotal) addKeyedRow(ws, sec.columns, sec.subtotal, true);
  }
  if (sheet.total && sheet.totalColumns) {
    ws.addRow([]);
    addKeyedRow(ws, sheet.totalColumns, sheet.total, true);
  }
}

export async function buildXlsxWorkbook(
  sheets: (XlsxSheet | XlsxSectionedSheet)[],
): Promise<Buffer> {
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
    if ('sections' in sheet) {
      renderSectionedSheet(ws, sheet);
      continue;
    }
    ws.columns = sheet.columns.map((col) => ({
      header: col.header,
      key: col.key,
      width: col.width ?? 16,
      style: col.numFmt ? { numFmt: col.numFmt } : {},
    }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const r of sheet.rows) ws.addRow(r);
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
