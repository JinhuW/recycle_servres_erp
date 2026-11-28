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

// The die-cut stock as TSPL's SIZE and GAP take it, units included:
// `{ size: '50 mm,25 mm', gap: '2 mm,0 mm' }`.
export type TsplStock = { size: string; gap: string };

export function tsplJob(r: Raster, stock: TsplStock): Uint8Array {
  // BITMAP prints a 0 bit, so the picture goes inverted.
  const bits = r.data.map(b => ~b & 0xff);
  return concat([
    ascii(`SIZE ${stock.size}\r\nGAP ${stock.gap}\r\nDIRECTION 1\r\nCLS\r\n`),
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

export function labelJob(lang: PrinterLanguage, r: Raster, stock: TsplStock): Uint8Array {
  return lang === 'zpl' ? zplJob(r) : lang === 'escpos' ? escposJob(r) : tsplJob(r, stock);
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

// Where printers put their serial port: the characteristic a job goes to, and
// the one the printer answers on. A service can carry others beside them.
// Microchip's (ISSC, the CLABEL CT221D's) lists a write-only characteristic
// before its port that goes nowhere, and a printer written there prints
// nothing. So each port is named, and only an unknown service's is guessed.
// Chrome lets a page open only the services it named when it asked for the
// device, so these are the whole list.
const ZEBRA = '38eb4a80-c570-11e3-9507-0002a5d5c51b';
const FF00 = '0000ff00-0000-1000-8000-00805f9b34fb';
const uuid16 = (n: string) => `0000${n}-0000-1000-8000-00805f9b34fb`;
const PORTS: Record<string, { write: string; notify: string }> = {
  [uuid16('18f0')]: { write: uuid16('2af1'), notify: uuid16('2af0') },
  [FF00]: { write: uuid16('ff02'), notify: uuid16('ff03') },
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2': {
    write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', notify: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
  },
  '49535343-fe7d-4ae5-8fa9-9fafd205e455': {
    write: '49535343-8841-43f4-a8d4-ecbe34729bb3', notify: '49535343-1e4d-4bd9-ba61-23c647249616',
  },
  [ZEBRA]: { write: '38eb4a82-c570-11e3-9507-0002a5d5c51b', notify: '38eb4a81-c570-11e3-9507-0002a5d5c51b' },
};
export const PRINTER_SERVICES = Object.keys(PORTS);

export function languageFor(service: string): PrinterLanguage {
  return service === ZEBRA ? 'zpl' : service === FF00 ? 'escpos' : 'tspl';
}

type CharProps = { write: boolean; writeWithoutResponse: boolean; notify: boolean };

// A service's port among its characteristics; null when nothing takes a write.
// An unknown service's guess prefers a characteristic that acknowledges writes.
export function pickPort<C extends { uuid: string; properties: CharProps }>(
  service: string, chars: readonly C[],
): { write: C; notify: C | null } | null {
  const named = PORTS[service];
  const write = (named && chars.find(c => c.uuid === named.write))
    ?? chars.find(c => c.properties.write)
    ?? chars.find(c => c.properties.writeWithoutResponse);
  if (!write) return null;
  const notify = (named && chars.find(c => c.uuid === named.notify && c.properties.notify))
    ?? chars.find(c => c.properties.notify)
    ?? null;
  return { write, notify };
}

export function chunks(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

// ── The connection ───────────────────────────────────────────────────────────
// The subset of Web Bluetooth used here; the DOM lib doesn't carry it.

type Char = EventTarget & {
  uuid: string;
  properties: CharProps;
  value?: DataView;
  writeValueWithResponse(v: Uint8Array): Promise<void>;
  writeValueWithoutResponse(v: Uint8Array): Promise<void>;
  startNotifications(): Promise<Char>;
};
type Service = { uuid: string; getCharacteristics(): Promise<Char[]> };
type Gatt = { connected: boolean; connect(): Promise<Gatt>; disconnect(): void; getPrimaryServices(): Promise<Service[]> };
type Device = EventTarget & {
  id: string;
  name?: string;
  gatt?: Gatt;
  watchAdvertisements?(o: { signal: AbortSignal }): Promise<void>;
};
type Bluetooth = {
  requestDevice(o: { acceptAllDevices: true; optionalServices: string[] }): Promise<Device>;
  getDevices?(): Promise<Device[]>;
};

const bluetooth = (): Bluetooth | undefined => (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;

export type PrinterStatus = {
  // `waiting`: the last printer dropped or isn't found yet, and the page will
  // connect it by itself once it answers. Labels go through the dialog meanwhile.
  state: 'unsupported' | 'off' | 'waiting' | 'connecting' | 'on' | 'printing';
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
// The printer last picked. A drop keeps it, so the page can wait for it.
let known: Device | null = null;
// Each pick or wait takes a turn. A newer turn, or Disconnect, ends the old one.
let turn = 0;
let scan: AbortController | null = null;
const watched = new WeakSet<Device>();
// A reconnect can hand back the same characteristic, which keeps its listener.
const listening = new WeakSet<Char>();
// One GATT operation at a time: Chrome refuses a write while another is in
// flight, and a status answer goes to whichever check is waiting for one.
let line: Promise<unknown> = Promise.resolve();
function inTurn<T>(op: () => Promise<T>): Promise<T> {
  const run = line.then(op);
  line = run.catch(() => {});
  return run;
}

const notify = () => listeners.forEach(l => l());

function set(next: Partial<PrinterStatus>) {
  status = { ...status, ...next };
  notify();
  if (owner) post({ t: 'status', from: self, status });
}

const UNSUPPORTED: PrinterStatus = { state: 'unsupported', name: null, language: 'tspl', paper: null };
const snapshot = () => (!bluetooth() ? UNSUPPORTED : !owner && remote ? remote.status : status);

// ── Across tabs ──────────────────────────────────────────────────────────────
// A label printer takes one connection, and while it has one it stops
// advertising: another tab finds it neither in the chooser nor by waiting for
// it, and two tabs writing at once would interleave their jobs. So one tab owns
// the printer, the one holding the lock, and only it speaks Bluetooth. The
// others show its status and hand it their labels and checks over a channel.
// When the owner closes or lets go, the next tab waiting on the lock connects.
// Without the locks API every tab owns its own, as before.
const LOCK = 'rs.labelPrinter';
const self = Math.random().toString(36).slice(2);
let owner = !navigatorLocks();
let release: (() => void) | null = null;
let holds = 0;
let queued: AbortController | null = null;
// The owning tab, as it last said.
let remote: { from: string; status: PrinterStatus } | null = null;

type Req = { op: 'print'; job: Uint8Array } | { op: 'check'; lang: PrinterLanguage } | { op: 'disconnect' };
type Msg =
  | { t: 'hello' }
  | { t: 'status'; from: string; status: PrinterStatus }
  | { t: 'gone'; from: string }
  | ({ t: 'req'; id: string; to: string } & Req)
  | { t: 'res'; id: string; ok: true; value: unknown }
  | { t: 'res'; id: string; ok: false; error: string };

const pending = new Map<string, { to: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let asked = 0;
let channel: BroadcastChannel | null | undefined;

function navigatorLocks(): LockManager | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.locks;
}

function bus(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(LOCK);
  if (!channel) return null;
  channel.addEventListener('message', e => void hear((e as MessageEvent<Msg>).data));
  channel.postMessage({ t: 'hello' } satisfies Msg);
  // The lock goes with the tab anyway; this just tells the others sooner.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { if (owner) post({ t: 'gone', from: self }); });
  }
  return channel;
}

function post(m: Msg) {
  bus()?.postMessage(m);
}

// Requests sent to a tab that stopped owning can't be answered.
function failPending(to: string) {
  for (const [id, p] of pending) {
    if (p.to !== to) continue;
    pending.delete(id);
    p.reject(new Error('disconnected'));
  }
}

function ask(req: Req): Promise<unknown> {
  const to = remote!.from;
  const id = `${self}:${++asked}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { to, resolve, reject });
    post({ t: 'req', id, to, ...req });
  });
}

async function hear(m: Msg): Promise<void> {
  switch (m.t) {
    case 'hello':
      if (owner) post({ t: 'status', from: self, status });
      return;
    case 'status':
      if (owner) return;
      if (remote && remote.from !== m.from) failPending(remote.from);
      remote = { from: m.from, status: m.status };
      notify();
      // Waits on the lock, to take over if the owner closes.
      if (m.status.state !== 'off') void labelPrinter.resume();
      return;
    case 'gone':
      if (remote?.from !== m.from) return;
      failPending(m.from);
      remote = null;
      notify();
      return;
    case 'req': {
      if (m.to !== self) return;
      try {
        if (!owner) throw new Error('disconnected');
        const value = m.op === 'print' ? await printHere(m.job)
          : m.op === 'check' ? await checkHere(m.lang)
          : forget();
        post({ t: 'res', id: m.id, ok: true, value: value ?? null });
      } catch (e) {
        post({ t: 'res', id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    case 'res': {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
    }
  }
}

// Resolves once this tab holds the lock, or false if it stopped waiting.
function hold(options: LockOptions): Promise<boolean> {
  const locks = navigatorLocks();
  if (!locks) return Promise.resolve(true);
  bus();
  const mine = ++holds;
  return new Promise(resolve => {
    let got = false;
    locks.request(LOCK, options, () => {
      got = true;
      owner = true;
      if (remote) { failPending(remote.from); remote = null; }
      resolve(true);
      return new Promise<void>(r => { release = r; });
    }).catch(() => {
      if (!got) resolve(false);
      else if (mine === holds && owner) stepDown();
    });
  });
}

// Another tab took the printer: this one lets its connection go and follows.
function stepDown() {
  owner = false;
  release = null;
  link = null;
  take(null);
  status = { ...status, state: 'off', name: null, paper: null };
  notify();
  post({ t: 'hello' });
}

function relinquish() {
  if (!navigatorLocks() || !owner) return;
  owner = false;
  post({ t: 'gone', from: self });
  release?.();
  release = null;
}

const remembered = (): string | null => {
  try { return localStorage.getItem(DEVICE_KEY); } catch { return null; /* private window */ }
};

// Starts a turn for `device`, ending any wait for another printer.
function take(device: Device | null): number {
  scan?.abort();
  scan = null;
  if (known && known !== device) known.gatt?.disconnect();
  known = device;
  return ++turn;
}

// Once another turn has started, this one leaves the link alone, and drops its
// connection unless the new turn wants the same printer.
async function open(device: Device, mine: number): Promise<void> {
  const gatt = await device.gatt!.connect();
  let found: { service: string; write: Char; notify: Char | null } | null = null;
  for (const s of await gatt.getPrimaryServices()) {
    const port = pickPort(s.uuid, await s.getCharacteristics());
    if (port) { found = { service: s.uuid, ...port }; break; }
  }
  if (mine !== turn) {
    if (known !== device) gatt.disconnect();
    return;
  }
  if (!found) {
    gatt.disconnect();
    throw new Error('no-port');
  }
  const { write, notify } = found;
  if (notify) {
    await notify.startNotifications();
    if (!listening.has(notify)) {
      listening.add(notify);
      notify.addEventListener('characteristicvaluechanged', () => {
        const v = notify.value;
        if (v && v.byteLength) reply?.(v.getUint8(0));
      });
    }
  }
  if (!watched.has(device)) {
    watched.add(device);
    device.addEventListener('gattserverdisconnected', () => {
      // Disconnect clears the link first, so only a drop gets past this.
      if (link?.device !== device) return;
      link = null;
      void reconnect(device);
    });
  }
  link = { device, write, notify };
  try { localStorage.setItem(DEVICE_KEY, device.id); } catch { /* private window */ }
  set({ state: 'on', name: device.name ?? null, language: languageFor(found.service), paper: null });
}

// Where Chrome can scan, the page hears the printer advertise before it
// connects, which is the order Chrome's own sample uses for a remembered
// device. Elsewhere the connect itself waits or fails.
function heard(device: Device): Promise<void> {
  if (!device.watchAdvertisements) return Promise.resolve();
  const stop = new AbortController();
  scan = stop;
  return new Promise<void>((resolve, reject) => {
    // Resolved first: abort runs its listener at once, which would reject.
    const onAd = () => { resolve(); stop.abort(); };
    device.addEventListener('advertisementreceived', onAd, { once: true });
    stop.signal.addEventListener('abort', () => {
      device.removeEventListener('advertisementreceived', onAd);
      reject(new Error('stopped'));
    });
    device.watchAdvertisements!({ signal: stop.signal }).catch(reject);
  });
}

// A printer that slept, was switched off or wandered out of range comes back
// by itself. The tries back off to every 10 s, until one connects or another
// turn starts.
async function reconnect(device: Device): Promise<void> {
  const mine = take(device);
  set({ state: 'waiting', name: device.name ?? null, paper: null });
  for (let pause = 2000; mine === turn; pause = Math.min(pause * 2, 10_000)) {
    try {
      await heard(device);
      await open(device, mine);
      return;
    } catch (e) {
      // A printer with no port this page knows won't grow one by waiting.
      if (e instanceof Error && e.message === 'no-port') {
        if (mine === turn) forget();
        return;
      }
      await new Promise(r => setTimeout(r, pause));
    }
  }
}

function forget() {
  link = null;
  take(null);
  try { localStorage.removeItem(DEVICE_KEY); } catch { /* private window */ }
  set({ state: 'off', name: null, paper: null });
  relinquish();
}

async function send(bytes: Uint8Array): Promise<void> {
  const { write } = link!;
  // Acknowledged where the port takes it: slower, but an unacknowledged write
  // is dropped once a small printer's buffer fills, and the label prints torn.
  // Without one, a pause now and then gives the buffer time to drain.
  const acked = write.properties.write;
  let n = 0;
  for (const c of chunks(bytes, 128)) {
    if (acked) await write.writeValueWithResponse(c);
    else {
      await write.writeValueWithoutResponse(c);
      if (++n % 16 === 0) await new Promise(r => setTimeout(r, 20));
    }
  }
}

// Asks the printer how it is; null when its language can't ask, it has no
// way to answer, or it doesn't within a second.
function checkHere(lang: PrinterLanguage): Promise<PaperState | null> {
  return inTurn(async () => {
    const query = STATUS_QUERY[lang];
    if (!link?.notify || !query || status.state !== 'on') return null;
    const answer = new Promise<number | null>(resolve => {
      reply = resolve;
      setTimeout(() => resolve(null), 1000);
    });
    let byte: number | null;
    try {
      await send(query);
      byte = await answer;
    } finally {
      reply = null;
    }
    const paper = byte === null ? null : readStatus(lang, byte);
    set({ paper });
    return paper;
  });
}

function printHere(job: Uint8Array): Promise<void> {
  return inTurn(async () => {
    // Disconnected while the job waited its turn.
    if (!link) throw new Error('disconnected');
    set({ state: 'printing' });
    try {
      await send(job);
    } finally {
      if (link) set({ state: 'on' });
    }
  });
}

// Another tab owns the printer, and this one goes through it.
const following = () => !owner && remote !== null;

export const labelPrinter = {
  subscribe(l: () => void) {
    bus();
    listeners.add(l);
    return () => { listeners.delete(l); };
  },

  // As it is now, for a print that waited its turn.
  status: snapshot,

  // Needs a click: Chrome opens its device chooser only from one. A printer
  // another tab has on is on here too.
  async connect(): Promise<void> {
    const bt = bluetooth();
    if (!bt || link) return;
    const there = following() ? remote!.status.state : 'off';
    if (there === 'on' || there === 'printing' || there === 'connecting') return;
    let device: Device;
    try {
      device = await bt.requestDevice({ acceptAllDevices: true, optionalServices: PRINTER_SERVICES });
    } catch {
      // The packer closed the chooser. A wait for the last printer carries on.
      return;
    }
    if (!owner) {
      // Takes the printer from a tab still waiting for it.
      queued?.abort();
      queued = null;
      await hold({ steal: true });
    }
    const mine = take(device);
    set({ state: 'connecting', name: device.name ?? null, paper: null });
    try {
      await open(device, mine);
    } catch (e) {
      if (mine === turn) {
        set({ state: 'off', name: null });
        relinquish();
      }
      throw e;
    }
  },

  // A printer this browser was allowed before, waited for without the chooser.
  // While another tab owns it, this waits for that tab to let it go.
  async resume(): Promise<void> {
    const bt = bluetooth();
    if (!bt?.getDevices || queued || link || (owner && status.state !== 'off') || !remembered()) return;
    if (!owner) {
      const q = new AbortController();
      queued = q;
      const got = await hold({ signal: q.signal });
      if (queued === q) queued = null;
      if (!got) return;
      // The owner's Disconnect forgot the printer before letting go.
      if (link || status.state !== 'off') return;
    }
    const id = remembered();
    const device = id ? (await bt.getDevices()).find(d => d.id === id) : undefined;
    if (device) void reconnect(device);
    else relinquish();
  },

  // Without getDevices, which Chrome keeps behind
  // chrome://flags/#enable-web-bluetooth-new-permissions-backend, a reload
  // forgets the printer.
  canResume: () => !!bluetooth()?.getDevices,

  disconnect(): void {
    if (following()) void ask({ op: 'disconnect' }).catch(() => {});
    else forget();
  },

  // Once a connect under way has finished or failed.
  settled(): Promise<PrinterStatus> {
    return new Promise(resolve => {
      const done = () => {
        const now = snapshot();
        if (now.state === 'connecting') return;
        listeners.delete(done);
        resolve(now);
      };
      listeners.add(done);
      done();
    });
  },

  check(lang: PrinterLanguage): Promise<PaperState | null> {
    return following() ? ask({ op: 'check', lang }) as Promise<PaperState | null> : checkHere(lang);
  },

  print(job: Uint8Array): Promise<void> {
    return following() ? ask({ op: 'print', job }).then(() => {}) : printHere(job);
  },
};

export function useLabelPrinter(): PrinterStatus {
  return useSyncExternalStore(labelPrinter.subscribe, snapshot);
}
