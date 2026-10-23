import { describe, it, expect } from 'vitest';
import { chunks, escposJob, languageFor, pickPort, PRINTER_SERVICES, readStatus, toRaster, tsplJob, zplJob, type Raster } from './labelPrinter';

// A w×h RGBA image, black where `dark(x, y)`.
const img = (w: number, h: number, dark: (x: number, y: number) => boolean) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const v = dark(x, y) ? 0 : 255;
    data.set([v, v, v, 255], i);
  }
  return { width: w, height: h, data };
};
const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

describe('toRaster', () => {
  it('packs a row into bytes, leftmost dot in the high bit, padding the last byte with paper', () => {
    const r = toRaster(img(10, 2, (x, y) => (y === 0 ? x === 0 || x === 9 : x === 1)));
    expect(r.widthBytes).toBe(2);
    expect([...r.data]).toEqual([0b1000_0000, 0b0100_0000, 0b0100_0000, 0]);
  });

  it('reads transparent as paper', () => {
    const r = toRaster({ width: 8, height: 1, data: new Uint8ClampedArray(32) });
    expect([...r.data]).toEqual([0]);
  });
});

describe('the label languages', () => {
  const r: Raster = { widthBytes: 2, height: 1, data: new Uint8Array([0xf0, 0x01]) };

  it('TSPL sizes the label in its stock\'s unit and sends the picture inverted, since BITMAP prints a 0', () => {
    const job = tsplJob(r, { size: '50 mm,25 mm', gap: '2 mm,0 mm' });
    const head = 'SIZE 50 mm,25 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nCLS\r\nBITMAP 0,0,2,1,0,';
    expect(text(job.subarray(0, head.length))).toBe(head);
    expect([...job.subarray(head.length, head.length + 2)]).toEqual([0x0f, 0xfe]);
    expect(text(job.subarray(head.length + 2))).toBe('\r\nPRINT 1,1\r\n');
  });

  it('ZPL sends the picture as a hex graphic field', () => {
    expect(text(zplJob(r))).toBe('^XA^PW16^LL1^FO0,0^GFA,2,2,2,F001^FS^XZ');
  });

  it('ESC/POS sends a raster image with its size in dots, then feeds', () => {
    expect([...escposJob(r)]).toEqual([
      0x1b, 0x40, 0x1d, 0x76, 0x30, 0x00, 2, 0, 1, 0, 0xf0, 0x01, 0x1b, 0x64, 0x03,
    ]);
  });
});

describe('readStatus', () => {
  it('reads TSPL\'s status byte', () => {
    expect(readStatus('tspl', 0x00)).toBe('ready');
    expect(readStatus('tspl', 0x01)).toBe('open');
    expect(readStatus('tspl', 0x04)).toBe('paper');
    expect(readStatus('tspl', 0x20)).toBe('busy');
    expect(readStatus('tspl', 0x02)).toBe('fault');
  });

  it('reads the ESC/POS paper sensor', () => {
    expect(readStatus('escpos', 0x12)).toBe('ready');
    expect(readStatus('escpos', 0x72)).toBe('paper');
  });
});

describe('languageFor', () => {
  it('reads a Zebra as ZPL, the FF00 port as ESC/POS, and the rest as TSPL', () => {
    expect(languageFor('38eb4a80-c570-11e3-9507-0002a5d5c51b')).toBe('zpl');
    expect(languageFor('0000ff00-0000-1000-8000-00805f9b34fb')).toBe('escpos');
    expect(languageFor('000018f0-0000-1000-8000-00805f9b34fb')).toBe('tspl');
    // Chrome opens only services named when asking for the device, in lower case.
    for (const s of PRINTER_SERVICES) expect(s).toBe(s.toLowerCase());
  });
});

describe('pickPort', () => {
  const ch = (uuid: string, ...props: ('write' | 'writeWithoutResponse' | 'notify')[]) => ({
    uuid, properties: { write: props.includes('write'), writeWithoutResponse: props.includes('writeWithoutResponse'), notify: props.includes('notify') },
  });
  it('takes the named port, not the first characteristic that takes a write', () => {
    // The CLABEL CT221D's Microchip service, in the order Chrome lists it.
    const chars = [
      ch('49535343-1e4d-4bd9-ba61-23c647249616', 'notify'),
      ch('49535343-6daa-4d02-abf6-19569aca69fe', 'writeWithoutResponse'),
      ch('49535343-8841-43f4-a8d4-ecbe34729bb3', 'writeWithoutResponse', 'write'),
      ch('49535343-aca3-481c-91ec-d85e28a60318', 'write', 'notify'),
    ];
    const port = pickPort('49535343-fe7d-4ae5-8fa9-9fafd205e455', chars)!;
    expect(port.write.uuid).toBe('49535343-8841-43f4-a8d4-ecbe34729bb3');
    expect(port.notify?.uuid).toBe('49535343-1e4d-4bd9-ba61-23c647249616');
  });

  it('guesses an unknown service\'s port, preferring a write the printer acknowledges', () => {
    const port = pickPort('0000abcd-0000-1000-8000-00805f9b34fb', [ch('a', 'writeWithoutResponse'), ch('b', 'write'), ch('c', 'notify')])!;
    expect(port.write.uuid).toBe('b');
    expect(port.notify?.uuid).toBe('c');
    expect(pickPort('x', [ch('c', 'notify')])).toBeNull();
  });
});

describe('chunks', () => {
  it('splits a job into writes of at most the size', () => {
    expect(chunks(new Uint8Array(5), 2).map(c => c.length)).toEqual([2, 2, 1]);
  });
});
