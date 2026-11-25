import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
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

// A CT221D-like printer over a fake Web Bluetooth. `failures` connects fail
// before one succeeds; `drop()` is the printer going to sleep. Like Chrome, it
// hands back the same characteristics on every connect. Each write takes 5 ms,
// and `overlapped` says whether one began while another was in flight.
class FakePrinter extends EventTarget {
  name: string;
  failures = 0;
  connects = 0;
  connectMs = 0;
  noPort = false;
  writes: Uint8Array[] = [];
  inFlight = 0;
  overlapped = false;
  watchAdvertisements?: (o: { signal: AbortSignal }) => Promise<void>;
  notifyChar = Object.assign(new EventTarget(), {
    uuid: '49535343-1e4d-4bd9-ba61-23c647249616',
    properties: { write: false, writeWithoutResponse: false, notify: true },
    startNotifications: async function () { return this; },
  });
  writeChar = Object.assign(new EventTarget(), {
    uuid: '49535343-8841-43f4-a8d4-ecbe34729bb3',
    properties: { write: true, writeWithoutResponse: true, notify: false },
    writeValueWithResponse: async (v: Uint8Array) => {
      if (this.inFlight) this.overlapped = true;
      this.inFlight++;
      this.writes.push(v);
      await new Promise(r => setTimeout(r, 5));
      this.inFlight--;
    },
  });
  gatt = {
    connected: false,
    connect: async () => {
      this.connects++;
      if (this.connectMs) await new Promise(r => setTimeout(r, this.connectMs));
      if (this.failures > 0) { this.failures--; throw new Error('NetworkError: Connection failed'); }
      this.gatt.connected = true;
      return this.gatt;
    },
    disconnect: () => {
      if (!this.gatt.connected) return;
      this.gatt.connected = false;
      this.dispatchEvent(new Event('gattserverdisconnected'));
    },
    getPrimaryServices: async () => [{
      uuid: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
      getCharacteristics: async () => (this.noPort ? [] : [this.notifyChar, this.writeChar]),
    }],
  };
  constructor(public id: string) { super(); this.name = `CT221D-${id}`; }
  drop() { this.gatt.connected = false; this.dispatchEvent(new Event('gattserverdisconnected')); }
}

describe('reconnecting the label printer', () => {
  let saved: Map<string, string>;
  const load = async (bluetooth: object) => {
    vi.stubGlobal('navigator', { bluetooth });
    vi.resetModules();
    return (await import('./labelPrinter')).labelPrinter;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    saved = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => { saved.set(k, v); },
      removeItem: (k: string) => { saved.delete(k); },
    });
    // One tab: nothing to hear from another.
    vi.stubGlobal('BroadcastChannel', undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits for a printer that dropped and connects it again without the chooser', async () => {
    const p = new FakePrinter('4FD1');
    const listen = vi.spyOn(p.notifyChar, 'addEventListener');
    const requestDevice = vi.fn(async () => p);
    const printer = await load({ requestDevice });
    await printer.connect();
    expect(printer.status()).toMatchObject({ state: 'on', name: 'CT221D-4FD1' });

    p.failures = 2;
    p.drop();
    expect(printer.status()).toMatchObject({ state: 'waiting', name: 'CT221D-4FD1' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(printer.status().state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(4000);
    expect(printer.status()).toMatchObject({ state: 'on', name: 'CT221D-4FD1' });
    expect(requestDevice).toHaveBeenCalledTimes(1);
    expect(p.connects).toBe(4);

    // Its drop listener isn't stacked by the reconnect: one drop, one wait.
    p.failures = 1;
    p.drop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(p.connects).toBe(6);
    // Nor its answer listener, on the characteristic it hands back each time.
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it('stops waiting for a printer that no longer shows a port it knows', async () => {
    const p = new FakePrinter('4FD1');
    const printer = await load({ requestDevice: async () => p });
    await printer.connect();
    p.noPort = true;
    p.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(printer.status()).toMatchObject({ state: 'off', name: null });
    const tries = p.connects;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.connects).toBe(tries);
    expect(saved.size).toBe(0);
  });

  it('sends one thing at a time: a label waits for the status check under way, and the next check for it', async () => {
    const p = new FakePrinter('4FD1');
    const printer = await load({ requestDevice: async () => p });
    await printer.connect();
    const all = Promise.all([
      printer.check('tspl'),
      printer.print(new Uint8Array(300).fill(1)),
      printer.check('tspl'),
    ]);
    await vi.advanceTimersByTimeAsync(3000);
    await all;
    expect(p.overlapped).toBe(false);
    // The query, the job's three chunks, then the second query.
    expect(p.writes.map(w => w[0])).toEqual([0x1b, 1, 1, 1, 0x1b]);
    expect(printer.status().state).toBe('on');
  });

  it('tells a label asked for mid-connect how the connect ended', async () => {
    const p = new FakePrinter('4FD1');
    p.connectMs = 100;
    const printer = await load({ requestDevice: async () => p });
    void printer.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(printer.status().state).toBe('connecting');
    let ended: string | null = null;
    void printer.settled().then(s => { ended = s.state; });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(ended).toBe('on');
    expect((await printer.settled()).state).toBe('on');
  });

  it('stops waiting on Disconnect, and forgets the printer', async () => {
    const p = new FakePrinter('4FD1');
    const printer = await load({ requestDevice: async () => p });
    await printer.connect();
    p.failures = 99;
    p.drop();
    await vi.advanceTimersByTimeAsync(0);
    printer.disconnect();
    const tries = p.connects;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.connects).toBe(tries);
    expect(printer.status()).toMatchObject({ state: 'off', name: null });
    expect(saved.size).toBe(0);
  });

  it('ends the wait when the chooser picks another printer, and carries on when it is closed', async () => {
    const a = new FakePrinter('4FD1');
    const b = new FakePrinter('9A20');
    const requestDevice = vi.fn().mockResolvedValueOnce(a).mockRejectedValueOnce(new Error('cancelled')).mockResolvedValueOnce(b);
    const printer = await load({ requestDevice });
    await printer.connect();
    a.failures = 99;
    a.drop();
    await vi.advanceTimersByTimeAsync(0);

    await printer.connect();
    expect(printer.status()).toMatchObject({ state: 'waiting', name: 'CT221D-4FD1' });

    await printer.connect();
    expect(printer.status()).toMatchObject({ state: 'on', name: 'CT221D-9A20' });
    const tries = a.connects;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.connects).toBe(tries);
    expect(saved.get('rs.labelPrinter')).toBe('9A20');
  });

  it('on load, waits for the remembered printer where Chrome offers getDevices', async () => {
    const p = new FakePrinter('4FD1');
    p.failures = 1;
    saved.set('rs.labelPrinter', '4FD1');
    const printer = await load({ requestDevice: vi.fn(), getDevices: async () => [new FakePrinter('0000'), p] });
    expect(printer.canResume()).toBe(true);
    await printer.resume();
    expect(printer.status()).toMatchObject({ state: 'waiting', name: 'CT221D-4FD1' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(printer.status()).toMatchObject({ state: 'on', name: 'CT221D-4FD1' });
  });

  it('hears the printer advertise before connecting, where Chrome can scan', async () => {
    const p = new FakePrinter('4FD1');
    let scanning: AbortSignal | null = null;
    p.watchAdvertisements = async ({ signal }) => { scanning = signal; };
    saved.set('rs.labelPrinter', '4FD1');
    const printer = await load({ requestDevice: vi.fn(), getDevices: async () => [p] });
    await printer.resume();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(p.connects).toBe(0);
    p.dispatchEvent(new Event('advertisementreceived'));
    await vi.advanceTimersByTimeAsync(0);
    expect(printer.status().state).toBe('on');
    expect(scanning!.aborted).toBe(true);
  });

  it('stays off on load without getDevices, or after a Disconnect', async () => {
    saved.set('rs.labelPrinter', '4FD1');
    const without = await load({ requestDevice: vi.fn() });
    expect(without.canResume()).toBe(false);
    await without.resume();
    expect(without.status().state).toBe('off');

    saved.clear();
    const printer = await load({ requestDevice: vi.fn(), getDevices: async () => [new FakePrinter('4FD1')] });
    await printer.resume();
    expect(printer.status().state).toBe('off');
  });
});

// Tabs of one browser: a lock manager and a channel they share, as Chrome's.
class FakeLocks {
  private holder: { done: (v: unknown) => void; fail: (e: Error) => void } | null = null;
  private waiting: (() => void)[] = [];
  request(_name: string, opts: { steal?: boolean; signal?: AbortSignal }, cb: () => Promise<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const grant = () => {
        const h = { done: resolve, fail: reject };
        this.holder = h;
        void Promise.resolve(cb()).then(v => {
          if (this.holder !== h) return;
          this.holder = null;
          resolve(v);
          this.waiting.shift()?.();
        });
      };
      if (opts.steal) {
        this.holder?.fail(new DOMException('stolen', 'AbortError'));
        grant();
      } else if (!this.holder) grant();
      else {
        this.waiting.push(grant);
        opts.signal?.addEventListener('abort', () => {
          this.waiting = this.waiting.filter(g => g !== grant);
          reject(new DOMException('aborted', 'AbortError'));
        });
      }
    });
  }
  // The holding tab closed.
  dropHolder() {
    this.holder = null;
    this.waiting.shift()?.();
  }
}

class FakeChannel extends EventTarget {
  static open: FakeChannel[] = [];
  constructor(public name: string) { super(); FakeChannel.open.push(this); }
  postMessage(data: unknown) {
    for (const c of FakeChannel.open) {
      if (c === this || c.name !== this.name) continue;
      const copy = structuredClone(data);
      setTimeout(() => { if (FakeChannel.open.includes(c)) c.dispatchEvent(new MessageEvent('message', { data: copy })); }, 0);
    }
  }
  close() { FakeChannel.open = FakeChannel.open.filter(c => c !== this); }
}

describe('the label printer across tabs', () => {
  let saved: Map<string, string>;
  let locks: FakeLocks;
  const tab = async () => {
    vi.resetModules();
    const printer = (await import('./labelPrinter')).labelPrinter;
    const unsubscribe = printer.subscribe(() => {});
    const channel = FakeChannel.open.at(-1)!;
    // Hello, and the owner's answer.
    await vi.advanceTimersByTimeAsync(10);
    return { printer, unsubscribe, close: () => channel.close() };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    saved = new Map();
    locks = new FakeLocks();
    FakeChannel.open = [];
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => { saved.set(k, v); },
      removeItem: (k: string) => { saved.delete(k); },
    });
    vi.stubGlobal('BroadcastChannel', FakeChannel);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // A printer that, like a real one, stops advertising while it has a connection.
  const setup = () => {
    const p = new FakePrinter('4FD1');
    p.watchAdvertisements = ({ signal }) => {
      const id = setInterval(() => { if (!p.gatt.connected) p.dispatchEvent(new Event('advertisementreceived')); }, 500);
      signal.addEventListener('abort', () => clearInterval(id));
      return Promise.resolve();
    };
    vi.stubGlobal('navigator', { locks, bluetooth: { requestDevice: vi.fn(async () => p), getDevices: async () => [p] } });
    return p;
  };

  it('shows a printer another tab has on, and prints through that tab', async () => {
    const p = setup();
    const a = await tab();
    await a.printer.connect();
    const b = await tab();
    // As the page does: a wait on the lock that settles once B owns the printer.
    void b.printer.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(b.printer.status()).toMatchObject({ state: 'on', name: 'CT221D-4FD1' });

    const out = b.printer.print(new Uint8Array(200).fill(7));
    await vi.advanceTimersByTimeAsync(100);
    await out;
    expect(p.writes.map(w => w[0])).toEqual([7, 7]);
    expect(p.connects).toBe(1);
  });

  it('keeps two tabs\' labels from interleaving', async () => {
    const p = setup();
    const a = await tab();
    await a.printer.connect();
    const b = await tab();
    const both = Promise.all([
      a.printer.print(new Uint8Array(300).fill(1)),
      b.printer.print(new Uint8Array(300).fill(2)),
      a.printer.print(new Uint8Array(300).fill(3)),
    ]);
    await vi.advanceTimersByTimeAsync(500);
    await both;
    expect(p.overlapped).toBe(false);
    // In the order they reach the owner, each job whole: B's comes over the channel.
    expect(p.writes.map(w => w[0])).toEqual([1, 1, 1, 3, 3, 3, 2, 2, 2]);
  });

  it('lets a waiting tab take the printer over when the owner closes', async () => {
    const p = setup();
    const a = await tab();
    await a.printer.connect();
    const b = await tab();
    // As the page does: a wait on the lock that settles once B owns the printer.
    void b.printer.resume();
    await vi.advanceTimersByTimeAsync(10);

    // A label B handed to A when A closed is lost, and B says so.
    p.connectMs = 50;
    const lost = b.printer.print(new Uint8Array(10)).catch((e: Error) => e.message);
    a.close();
    p.gatt.disconnect();
    locks.dropHolder();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await lost).toBe('disconnected');
    expect(b.printer.status()).toMatchObject({ state: 'on', name: 'CT221D-4FD1' });
    const out = b.printer.print(new Uint8Array(10).fill(5));
    await vi.advanceTimersByTimeAsync(50);
    await out;
    expect(p.writes.at(-1)![0]).toBe(5);
  });

  it('forgets the printer in every tab on Disconnect in any of them', async () => {
    setup();
    const a = await tab();
    await a.printer.connect();
    const b = await tab();
    // As the page does: a wait on the lock that settles once B owns the printer.
    void b.printer.resume();
    await vi.advanceTimersByTimeAsync(10);

    b.printer.disconnect();
    await vi.advanceTimersByTimeAsync(100);
    expect(a.printer.status()).toMatchObject({ state: 'off', name: null });
    expect(b.printer.status()).toMatchObject({ state: 'off', name: null });
    expect(saved.size).toBe(0);
    // B got the lock A let go of, found nothing to wait for, and let it go too.
    const c = await tab();
    await c.printer.connect();
    expect(c.printer.status().state).toBe('on');
  });

  it('takes the printer from a tab still waiting for it on Connect', async () => {
    const p = setup();
    const a = await tab();
    await a.printer.connect();
    p.failures = 99;
    p.drop();
    await vi.advanceTimersByTimeAsync(0);
    const b = await tab();
    expect(b.printer.status().state).toBe('waiting');

    p.failures = 0;
    await b.printer.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(b.printer.status()).toMatchObject({ state: 'on', name: 'CT221D-4FD1' });
    expect(a.printer.status()).toMatchObject({ state: 'on', name: 'CT221D-4FD1' });
    // A stopped trying, and prints through B.
    const tries = p.connects;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.connects).toBe(tries);
    const out = a.printer.print(new Uint8Array(10).fill(9));
    await vi.advanceTimersByTimeAsync(50);
    await out;
    expect(p.writes.at(-1)![0]).toBe(9);
  });
});
