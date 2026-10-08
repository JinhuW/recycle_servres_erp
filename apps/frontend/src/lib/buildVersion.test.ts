import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLE_VERSION, fetchLiveVersion, isStale } from './buildVersion';

const GAP = 5 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('isStale', () => {
  it('is stale only when the live version reads and differs', () => {
    expect(isStale('1.220.3', '1.220.4')).toBe(true);
    expect(isStale('1.220.3', '1.220.3')).toBe(false);
  });

  it('never calls an unreadable answer stale', () => {
    expect(isStale('1.220.3', undefined)).toBe(false);
    expect(isStale('1.220.3', null)).toBe(false);
    expect(isStale('1.220.3', '')).toBe(false);
    expect(isStale('1.220.3', 1220)).toBe(false);
    expect(isStale('1.220.3', { version: '1.220.4' })).toBe(false);
  });
});

describe('BUNDLE_VERSION', () => {
  it('is the root package.json version the config defines', () => {
    expect(BUNDLE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('fetchLiveVersion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the version without any cache', async () => {
    const fetchMock = vi.fn(async () => json({ version: '1.220.4' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchLiveVersion()).resolves.toBe('1.220.4');
    expect(fetchMock).toHaveBeenCalledWith('/version.json', { cache: 'no-store' });
  });

  it('reads nothing from a 404, the dev server\'s index.html, or a dropped request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ version: '9.9.9' }, 404)));
    await expect(fetchLiveVersion()).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 })));
    await expect(fetchLiveVersion()).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => json(null)));
    await expect(fetchLiveVersion()).resolves.toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(fetchLiveVersion()).resolves.toBeUndefined();
  });
});

// Node environment: window and document are plain EventTargets, and fetch
// answers with a bare object so no real body stream meets the fake timers.
const answer = (version: unknown) => ({ ok: true, json: async () => ({ version }) });

describe('watchBundleVersion', () => {
  let doc: EventTarget & { visibilityState: string };
  let win: EventTarget;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    win = new EventTarget();
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    fetchMock = vi.fn(async () => answer('newer'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function start() {
    const mod = await import('./buildVersion');
    const onStale = vi.fn();
    win.addEventListener(mod.BUNDLE_STALE_EVENT, onStale);
    const stop = mod.watchBundleVersion();
    return { mod, onStale, stop };
  }

  const show = (state: 'visible' | 'hidden') => {
    doc.visibilityState = state;
    doc.dispatchEvent(new Event('visibilitychange'));
  };

  it('counts the page load as a check, then asks once the gap has passed', async () => {
    const { mod, onStale } = await start();
    show('visible');
    await vi.advanceTimersByTimeAsync(GAP - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(mod.bundleStale()).toBe(true);
  });

  it('asks at most once per gap, however often the tab comes back', async () => {
    fetchMock.mockImplementation(async () => answer(BUNDLE_VERSION));
    const { onStale } = await start();
    await vi.advanceTimersByTimeAsync(GAP);
    show('hidden');
    show('visible');
    show('visible');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onStale).not.toHaveBeenCalled();
  });

  it('leaves a hidden tab alone until it is shown again', async () => {
    await start();
    show('hidden');
    await vi.advanceTimersByTimeAsync(3 * GAP);
    expect(fetchMock).not.toHaveBeenCalled();
    show('visible');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the live version cannot be read', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    }));
    const { mod, onStale } = await start();
    await vi.advanceTimersByTimeAsync(GAP);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onStale).not.toHaveBeenCalled();
    expect(mod.bundleStale()).toBe(false);
  });

  it('stops asking once stale, and when stopped', async () => {
    const first = await start();
    await vi.advanceTimersByTimeAsync(GAP);
    expect(first.mod.bundleStale()).toBe(true);
    await vi.advanceTimersByTimeAsync(3 * GAP);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.resetModules();
    fetchMock.mockClear();
    const second = await start();
    second.stop();
    await vi.advanceTimersByTimeAsync(3 * GAP);
    show('visible');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
