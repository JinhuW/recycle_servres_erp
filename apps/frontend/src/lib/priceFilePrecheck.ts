// Client-side sanity check for a vendor price sheet, run before the file is
// uploaded: is it really an .xlsx, is it within the size cap, and do its
// sheets mention a Part Number and a Unit Price column at all? The backend
// preview endpoint stays authoritative — this only catches the obvious wrong
// file early, without shipping a spreadsheet library to the browser (.xlsx is
// a zip; the header texts are readable with a ~zero-dependency zip walk).
//
// Header aliases are kept in lockstep with the backend parser
// (backend/src/services/sellOrderPriceImport.ts).

export type PriceFilePrecheck =
  | { ok: true }
  | { ok: false; reason: 'not-xlsx' | 'too-large' | 'no-rows' }
  | { ok: false; reason: 'columns-missing'; missing: ('part' | 'price')[] };

export const PRICE_FILE_MAX_BYTES = 8 * 1024 * 1024;

const normHeader = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9一-鿿#]/g, '');

const PART_EXACT = new Set(['part', 'partno', 'pn', 'part#', '编号']);
const PART_CONTAINS = ['partnumber', '型号', '零件号', '料号'];
const isPartHeader = (h: string) =>
  PART_EXACT.has(h) || PART_CONTAINS.some(k => h.includes(k));

const isPriceHeader = (h: string) => {
  if (h.includes('total') || h.includes('总')) return false;
  return h.includes('unitprice') || h.includes('单价') || h.includes('price') || h.includes('价格');
};

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
};

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readZipDirectory(buf: Uint8Array): ZipEntry[] | null {
  if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End-of-central-directory record sits at the tail (before an optional
  // comment, max 64 KiB) — scan backwards for its signature.
  let eocd = -1;
  const stop = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || view.getUint32(offset, true) !== CENTRAL_SIG) return null;
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    entries.push({
      name: decoder.decode(buf.subarray(offset + 46, offset + 46 + nameLen)),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateEntry(buf: Uint8Array, entry: ZipEntry): Promise<string | null> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const at = entry.localHeaderOffset;
  if (at + 30 > buf.length || view.getUint32(at, true) !== LOCAL_SIG) return null;
  // The local header's name/extra lengths can differ from the central copy.
  const nameLen = view.getUint16(at + 26, true);
  const extraLen = view.getUint16(at + 28, true);
  const start = at + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  try {
    if (entry.method === 0) return new TextDecoder().decode(data);
    if (entry.method !== 8) return null;
    const stream = new Blob([new Uint8Array(data)]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}

// Cell texts live in <t> elements — sharedStrings entries and inline strings.
function extractTexts(xml: string): string[] {
  const out: string[] = [];
  const re = /<t(?:\s[^>]*)?>([^<]*)<\/t>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
}

export async function precheckPriceFile(
  file: File,
  maxBytes = PRICE_FILE_MAX_BYTES,
): Promise<PriceFilePrecheck> {
  if (file.size > maxBytes) return { ok: false, reason: 'too-large' };
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = readZipDirectory(buf);
  if (!entries || !entries.some(e => e.name.startsWith('xl/'))) {
    return { ok: false, reason: 'not-xlsx' };
  }

  let part = false;
  let price = false;
  let rowCount = 0;
  for (const entry of entries) {
    const isSheet = /^xl\/worksheets\/[^/]+\.xml$/.test(entry.name);
    if (!isSheet && entry.name !== 'xl/sharedStrings.xml') continue;
    const xml = await inflateEntry(buf, entry);
    if (!xml) continue;
    if (isSheet) rowCount += (xml.match(/<row[\s>]/g) ?? []).length;
    for (const text of extractTexts(xml)) {
      const h = normHeader(text);
      if (h === '') continue;
      if (!part && isPartHeader(h)) part = true;
      if (!price && isPriceHeader(h)) price = true;
    }
  }
  if (!part || !price) {
    const missing: ('part' | 'price')[] = [];
    if (!part) missing.push('part');
    if (!price) missing.push('price');
    return { ok: false, reason: 'columns-missing', missing };
  }
  // Headers alone aren't a usable table — a header-only sheet means the
  // vendor sent back an empty file (or the wrong tab survived).
  if (rowCount <= 1) return { ok: false, reason: 'no-rows' };
  return { ok: true };
}
