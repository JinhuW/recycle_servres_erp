import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Node environment (no jsdom): shim the browser globals registerPwa touches.
// An installed PWA resumes from the home screen without a navigation, so the
// browser never re-checks sw.js by itself — these tests pin the app-driven
// re-check (foreground + interval) that makes deploys reach installed clients.

type RegisterSWOptions = {
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisterError?: (err: unknown) => void;
  onRegisteredSW?: (swUrl: string, reg: ServiceWorkerRegistration | undefined) => void;
};

let capturedOptions: RegisterSWOptions | undefined;

vi.mock('virtual:pwa-register', () => ({
  registerSW: (options: RegisterSWOptions) => {
    capturedOptions = options;
    return vi.fn(async () => {});
  },
}));

function shimBrowserGlobals(): void {
  const win = new EventTarget() as EventTarget & {
    location: { pathname: string };
    innerWidth: number;
    dispatchEvent: (e: Event) => boolean;
  };
  win.location = { pathname: '/' };
  win.innerWidth = 390; // phone width — PWA path is mobile-only
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true });

  const doc = new EventTarget() as EventTarget & { visibilityState: string };
  doc.visibilityState = 'visible';
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });

  Object.defineProperty(globalThis, 'navigator', {
    value: { serviceWorker: { getRegistrations: async () => [] } },
    configurable: true,
  });
}

describe('pwa update re-check', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    capturedOptions = undefined;
    shimBrowserGlobals();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function registerAndGetHook() {
    const { registerPwa } = await import('../src/lib/pwa');
    registerPwa();
    expect(capturedOptions?.onRegisteredSW, 'registerSW must wire onRegisteredSW').toBeTypeOf('function');
    const update = vi.fn(async () => {});
    const reg = { update } as unknown as ServiceWorkerRegistration;
    capturedOptions!.onRegisteredSW!('/sw.js', reg);
    return { update };
  }

  it('checks for a new SW when the app returns to the foreground', async () => {
    const { update } = await registerAndGetHook();
    update.mockClear();

    (document as unknown as { visibilityState: string }).visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).toHaveBeenCalledTimes(1);

    // Going to the background must not trigger a check.
    (document as unknown as { visibilityState: string }).visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('checks for a new SW periodically while the app stays open', async () => {
    const { update } = await registerAndGetHook();
    update.mockClear();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('survives an offline update check (rejected promise)', async () => {
    const { update } = await registerAndGetHook();
    update.mockClear();
    update.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    // The rejection must be swallowed; the next foreground still checks.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(update).toHaveBeenCalledTimes(2);
  });
});
