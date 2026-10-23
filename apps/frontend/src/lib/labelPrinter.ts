// Pack mode's Bluetooth label printer. Chrome on the Mac talks to it over Web
// Bluetooth (Safari has none). No printer model is on record, so the page
// speaks the three languages Bluetooth label printers use: TSPL (most thermal
// label printers), ZPL (Zebra) and ESC/POS raster (Phomemo and receipt-style
// ones). It picks one from the service the printer exposes, and the packer can
// override it. The label goes as one 1-bit picture, so every language prints
// the same thing. The page can't reach a printer only the OS knows, so the
// print dialog stays as the fallback.

import { useSyncExternalStore } from 'react';

export type PrinterLanguage = 'tspl' | 'zpl' | 'escpos';

// The label as dots: rows of bytes, the leftmost dot in the high bit, 1 = black.
export type Raster = { widthBytes: number; height: number; data: Uint8Array };

// Thermal label printers are 203 dpi, unless they are one of the rare 300s.
export const PRINTER_DPI = 203;

export function toRaster(img: { width: number; height: number; data: Uint8ClampedArray }, threshold = 160): Raster {
  const widthBytes = Math.ceil(img.width / 8);
  const data = new Uint8Array(widthBytes * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      // Transparent counts as paper.
      const a = img.data[i + 3]! / 255;
      const lum = (0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!) * a + 255 * (1 - a);
      if (lum < threshold) data[y * widthBytes + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return { widthBytes, height: img.height, data };
}

const ascii = (s: string) => new TextEncoder().encode(s);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// TSPL. The stock is die-cut, with the common 3 mm gap between labels.
export function tsplJob(r: Raster, widthIn: number, heightIn: number): Uint8Array {
  // BITMAP prints a 0 bit, so the picture goes inverted.
  const bits = r.data.map(b => ~b & 0xff);
  return concat([
    ascii(`SIZE ${widthIn},${heightIn}\r\nGAP 0.12,0\r\nDIRECTION 1\r\nCLS\r\n`),
    ascii(`BITMAP 0,0,${r.widthBytes},${r.height},0,`),
    bits,
    ascii('\r\nPRINT 1,1\r\n'),
  ]);
}

export function zplJob(r: Raster): Uint8Array {
  const total = r.data.length;
  let hex = '';
  for (const b of r.data) hex += b.toString(16).padStart(2, '0');
  return ascii(`^XA^PW${r.widthBytes * 8}^LL${r.height}^FO0,0^GFA,${total},${total},${r.widthBytes},${hex.toUpperCase()}^FS^XZ`);
}

// ESC/POS raster (GS v 0), then a feed out to the tear bar.
export function escposJob(r: Raster): Uint8Array {
  const head = new Uint8Array([
    0x1b, 0x40,
    0x1d, 0x76, 0x30, 0x00,
    r.widthBytes & 0xff, r.widthBytes >> 8, r.height & 0xff, r.height >> 8,
  ]);
  return concat([head, r.data, new Uint8Array([0x1b, 0x64, 0x03])]);
}

export function labelJob(lang: PrinterLanguage, r: Raster, widthIn: number, heightIn: number): Uint8Array {
  return lang === 'zpl' ? zplJob(r) : lang === 'escpos' ? escposJob(r) : tsplJob(r, widthIn, heightIn);
}

// What the printer says about itself, where its language can ask: TSPL's
// `ESC ! ?` and ESC/POS's paper sensor (`DLE EOT 4`). Each answers one byte.
// ZPL's answer is a multi-line report, so a Zebra only shows connected.
export type PaperState = 'ready' | 'paper' | 'open' | 'busy' | 'fault';

export const STATUS_QUERY: Record<PrinterLanguage, Uint8Array | null> = {
  tspl: new Uint8Array([0x1b, 0x21, 0x3f]),
  escpos: new Uint8Array([0x10, 0x04, 0x04]),
  zpl: null,
};

export function readStatus(lang: PrinterLanguage, byte: number): PaperState {
  if (lang === 'escpos') return byte & 0x60 ? 'paper' : 'ready';
  if (byte === 0) return 'ready';
  if (byte & 0x01) return 'open';
  if (byte & 0x04) return 'paper';
  if (byte & 0x20) return 'busy';
  return 'fault';
}

// Where printers put their serial port. Chrome lets a page open only the
// services it named when it asked for the device, so this is the whole list.
const ZEBRA = '38eb4a80-c570-11e3-9507-0002a5d5c51b';
const FF00 = '0000ff00-0000-1000-8000-00805f9b34fb';
export const PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  FF00,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  ZEBRA,
];

export function languageFor(service: string): PrinterLanguage {
  return service === ZEBRA ? 'zpl' : service === FF00 ? 'escpos' : 'tspl';
}

export function chunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

// ── The connection ───────────────────────────────────────────────────────────
// The subset of Web Bluetooth used here; the DOM lib doesn't carry it.

type Char = EventTarget & {
  properties: { write: boolean; writeWithoutResponse: boolean; notify: boolean };
  value?: DataView;
  writeValueWithResponse(v: Uint8Array): Promise<void>;
  writeValueWithoutResponse(v: Uint8Array): Promise<void>;
  startNotifications(): Promise<Char>;
};
type Service = { uuid: string; getCharacteristics(): Promise<Char[]> };
type Gatt = { connected: boolean; connect(): Promise<Gatt>; disconnect(): void; getPrimaryServices(): Promise<Service[]> };
type Device = EventTarget & { id: string; name?: string; gatt?: Gatt };
type Bluetooth = {
  requestDevice(o: { acceptAllDevices: true; optionalServices: string[] }): Promise<Device>;
  getDevices?(): Promise<Device[]>;
};

const bluetooth = (): Bluetooth | undefined => (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;

export type PrinterStatus = {
  state: 'unsupported' | 'off' | 'connecting' | 'on' | 'printing';
  name: string | null;
  // The language the printer's service implies.
  language: PrinterLanguage;
  paper: PaperState | null;
};

// Survives leaving Pack mode, so the printer stays connected for the next order.
let status: PrinterStatus = { state: 'off', name: null, language: 'tspl', paper: null };
let link: { device: Device; write: Char; notify: Char | null } | null = null;
let reply: ((byte: number) => void) | null = null;
const listeners = new Set<() => void>();
// Remembered so a reload can reconnect without the chooser.
const DEVICE_KEY = 'rs.labelPrinter';

function set(next: Partial<PrinterStatus>) {
  status = { ...status, ...next };
  listeners.forEach(l => l());
}

const UNSUPPORTED: PrinterStatus = { state: 'unsupported', name: null, language: 'tspl', paper: null };
const snapshot = () => (bluetooth() ? status : UNSUPPORTED);

async function open(device: Device): Promise<void> {
  set({ state: 'connecting', name: device.name ?? null });
  const gatt = await device.gatt!.connect();
  const services = await gatt.getPrimaryServices();
  for (const s of services) {
    const chars = await s.getCharacteristics();
    const write = chars.find(c => c.properties.writeWithoutResponse || c.properties.write);
    if (!write) continue;
    const notify = chars.find(c => c.properties.notify) ?? null;
    if (notify) {
      await notify.startNotifications();
      notify.addEventListener('characteristicvaluechanged', () => {
        const v = notify.value;
        if (v && v.byteLength) reply?.(v.getUint8(0));
      });
    }
    device.addEventListener('gattserverdisconnected', () => {
      if (link?.device !== device) return;
      link = null;
      set({ state: 'off', paper: null });
    });
    link = { device, write, notify };
    try { localStorage.setItem(DEVICE_KEY, device.id); } catch { /* private window */ }
    set({ state: 'on', language: languageFor(s.uuid), paper: null });
    return;
  }
  gatt.disconnect();
  throw new Error('no-port');
}

async function send(bytes: Uint8Array): Promise<void> {
  const { write } = link!;
  // A write the printer acknowledges is slower but can't overrun its buffer;
  // without one, a pause now and then gives it time to drain.
  const acked = !write.properties.writeWithoutResponse;
  let n = 0;
  for (const c of chunks(bytes, 180)) {
    if (acked) await write.writeValueWithResponse(c);
    else {
      await write.writeValueWithoutResponse(c);
      if (++n % 16 === 0) await new Promise(r => setTimeout(r, 20));
    }
  }
}

export const labelPrinter = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },

  // Needs a click: Chrome opens its device chooser only from one.
  async connect(): Promise<void> {
    const bt = bluetooth();
    if (!bt || link) return;
    let device: Device;
    try {
      device = await bt.requestDevice({ acceptAllDevices: true, optionalServices: PRINTER_SERVICES });
    } catch {
      // The packer closed the chooser.
      return;
    }
    try {
      await open(device);
    } catch (e) {
      set({ state: 'off', name: null });
      throw e;
    }
  },

  // A printer this browser was allowed before, reconnected without the chooser.
  async resume(): Promise<void> {
    const bt = bluetooth();
    if (!bt?.getDevices || link || status.state !== 'off') return;
    let id: string | null = null;
    try { id = localStorage.getItem(DEVICE_KEY); } catch { /* private window */ }
    const device = id ? (await bt.getDevices()).find(d => d.id === id) : undefined;
    if (!device) return;
    await open(device).catch(() => set({ state: 'off', name: null }));
  },

  disconnect(): void {
    const d = link?.device;
    link = null;
    try { localStorage.removeItem(DEVICE_KEY); } catch { /* private window */ }
    d?.gatt?.disconnect();
    set({ state: 'off', name: null, paper: null });
  },

  // Asks the printer how it is; null when its language can't ask, it has no
  // way to answer, or it doesn't within a second.
  async check(lang: PrinterLanguage): Promise<PaperState | null> {
    const query = STATUS_QUERY[lang];
    if (!link?.notify || !query || status.state !== 'on') return null;
    const answer = new Promise<number | null>(resolve => {
      reply = resolve;
      setTimeout(() => resolve(null), 1000);
    });
    await send(query);
    const byte = await answer;
    reply = null;
    const paper = byte === null ? null : readStatus(lang, byte);
    set({ paper });
    return paper;
  },

  async print(job: Uint8Array): Promise<void> {
    set({ state: 'printing' });
    try {
      await send(job);
    } finally {
      if (link) set({ state: 'on' });
    }
  },
};

export function useLabelPrinter(): PrinterStatus {
  return useSyncExternalStore(labelPrinter.subscribe, snapshot);
}
