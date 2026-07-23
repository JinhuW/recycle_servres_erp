import { describe, it, expect } from 'vitest';
import { precheckPriceFile } from './priceFilePrecheck';
import { PRICE_TEMPLATE_SAMPLE_B64 } from './__fixtures__/priceTemplateSample';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const fixture = Uint8Array.from(atob(PRICE_TEMPLATE_SAMPLE_B64), c => c.charCodeAt(0));

function asFile(bytes: Uint8Array, name = 'prices.xlsx'): File {
  return new File([new Uint8Array(bytes)], name, { type: XLSX_MIME });
}

// Minimal zip builder (stored entries, no compression) — enough for the
// precheck's reader, which understands methods 0 and 8.
function storedZip(entries: { name: string; text: string }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: number[] = [];
  const central: number[] = [];
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = enc.encode(e.text);
    const offset = chunks.length;
    chunks.push(
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
      ...name, ...data,
    );
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(name.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ...name,
    );
  }
  const cdOffset = chunks.length;
  const cd = central;
  const out = [
    ...chunks, ...cd,
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(cd.length), ...u32(cdOffset), ...u16(0),
  ];
  return new Uint8Array(out);
}

const SHARED = (strings: string[]) =>
  `<?xml version="1.0"?><sst>${strings.map(s => `<si><t>${s}</t></si>`).join('')}</sst>`;

describe('precheckPriceFile', () => {
  it('accepts a real generated price template', async () => {
    const res = await precheckPriceFile(asFile(fixture));
    expect(res).toEqual({ ok: true });
  });

  it('rejects a file that is not a zip at all', async () => {
    const res = await precheckPriceFile(asFile(new TextEncoder().encode('part,price\nA,1')));
    expect(res).toEqual({ ok: false, reason: 'not-xlsx' });
  });

  it('rejects a zip that is not a workbook', async () => {
    const zip = storedZip([{ name: 'readme.txt', text: 'hello' }]);
    const res = await precheckPriceFile(asFile(zip));
    expect(res).toEqual({ ok: false, reason: 'not-xlsx' });
  });

  it('rejects an oversized file without reading it', async () => {
    const res = await precheckPriceFile(asFile(fixture), 1000);
    expect(res).toEqual({ ok: false, reason: 'too-large' });
  });

  it('reports both columns missing with specifics', async () => {
    const zip = storedZip([
      { name: 'xl/workbook.xml', text: '<workbook/>' },
      { name: 'xl/worksheets/sheet1.xml', text: '<worksheet><row r="1"/><row r="2"/></worksheet>' },
      { name: 'xl/sharedStrings.xml', text: SHARED(['Foo', 'Bar', 'Total']) },
    ]);
    const res = await precheckPriceFile(asFile(zip));
    expect(res).toEqual({ ok: false, reason: 'columns-missing', missing: ['part', 'price'] });
  });

  it('reports only the price column missing when Part Number exists', async () => {
    // Line Total must not satisfy the price requirement.
    const zip = storedZip([
      { name: 'xl/workbook.xml', text: '<workbook/>' },
      { name: 'xl/worksheets/sheet1.xml', text: '<worksheet><row r="1"/><row r="2"/></worksheet>' },
      { name: 'xl/sharedStrings.xml', text: SHARED(['Part Number', 'Line Total (USD)']) },
    ]);
    const res = await precheckPriceFile(asFile(zip));
    expect(res).toEqual({ ok: false, reason: 'columns-missing', missing: ['price'] });
  });

  it('reports only the part column missing when Unit Price exists', async () => {
    const zip = storedZip([
      { name: 'xl/workbook.xml', text: '<workbook/>' },
      { name: 'xl/worksheets/sheet1.xml', text: '<worksheet><row r="1"/><row r="2"/></worksheet>' },
      { name: 'xl/sharedStrings.xml', text: SHARED(['Unit Price (USD)', 'Qty']) },
    ]);
    const res = await precheckPriceFile(asFile(zip));
    expect(res).toEqual({ ok: false, reason: 'columns-missing', missing: ['part'] });
  });

  it('accepts Chinese headers', async () => {
    const zip = storedZip([
      { name: 'xl/workbook.xml', text: '<workbook/>' },
      { name: 'xl/worksheets/sheet1.xml', text: '<worksheet><row r="1"/><row r="2"/></worksheet>' },
      { name: 'xl/sharedStrings.xml', text: SHARED(['型号', '数量', '单价']) },
    ]);
    const res = await precheckPriceFile(asFile(zip));
    expect(res).toEqual({ ok: true });
  });

  it('finds inline-string headers in the sheet itself', async () => {
    const zip = storedZip([
      { name: 'xl/workbook.xml', text: '<workbook/>' },
      {
        name: 'xl/worksheets/sheet1.xml',
        text: '<worksheet><row r="1"><is><t>Part Number</t></is><is><t>Unit Price</t></is></row><row r="2"/></worksheet>',
      },
    ]);
    const res = await precheckPriceFile(asFile(zip));
    expect(res).toEqual({ ok: true });
  });

  it('flags a header-only table with no data rows', async () => {
    const zip = storedZip([
      { name: 'xl/workbook.xml', text: '<workbook/>' },
      {
        name: 'xl/worksheets/sheet1.xml',
        text: '<worksheet><row r="1"><is><t>Part Number</t></is><is><t>Unit Price</t></is></row></worksheet>',
      },
    ]);
    const res = await precheckPriceFile(asFile(zip));
    expect(res).toEqual({ ok: false, reason: 'no-rows' });
  });
});
