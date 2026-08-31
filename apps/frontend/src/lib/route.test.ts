import { describe, it, expect, afterEach } from 'vitest';
import { navigate, navigateBack, parseShippingRoute, pathToDesktopView, readSafeNext } from './route';

// `/shipping/new` shares a shape with `/shipping/:orderId`, so the parser's
// check order is what keeps the wizard from being read as a PO id.
describe('parseShippingRoute', () => {
  it('distinguishes the wizard from an order id', () => {
    expect(parseShippingRoute('/shipping/new')).toEqual({ kind: 'wizardNew' });
    expect(parseShippingRoute('/shipping/PO-1372')).toEqual({ kind: 'focus', orderId: 'PO-1372' });
  });

  it('parses the dashboard and the per-PO wizard routes', () => {
    expect(parseShippingRoute('/shipping')).toEqual({ kind: 'dashboard' });
    expect(parseShippingRoute('/shipping/PO-1372/label'))
      .toEqual({ kind: 'wizardPo', orderId: 'PO-1372', sid: null });
    expect(parseShippingRoute('/shipping/PO-1372/label/sh_9'))
      .toEqual({ kind: 'wizardPo', orderId: 'PO-1372', sid: 'sh_9' });
  });

  it('returns null off the shipping tree', () => {
    expect(parseShippingRoute('/purchase-orders/PO-1372')).toBeNull();
    expect(parseShippingRoute('/shipping/PO-1372/other')).toBeNull();
  });

  it('keeps every shipping shape on the shipping view', () => {
    for (const p of ['/shipping', '/shipping/new', '/shipping/PO-1372', '/shipping/PO-1372/label', '/shipping/PO-1372/label/sh_9']) {
      expect(pathToDesktopView(p)).toBe('shipping');
    }
  });

  // A client is a shareable link, so the detail path has to resolve too.
  it('maps /clients and a deep link to one client', () => {
    expect(pathToDesktopView('/clients')).toBe('clients');
    expect(pathToDesktopView('/clients/2f1c0b7e-0000-4000-8000-000000000000')).toBe('clients');
  });
});

// `next` comes back from the backend's /oauth/authorize bounce and is then fed
// straight to window.location.replace, so anything that escapes the origin here
// is an open redirect on the login page.
describe('readSafeNext', () => {
  it('returns a same-origin absolute path', () => {
    expect(readSafeNext('?next=%2Foauth%2Fauthorize%3Freq%3Dabc'))
      .toBe('/oauth/authorize?req=abc');
  });

  it('returns null when absent or empty', () => {
    expect(readSafeNext('')).toBeNull();
    expect(readSafeNext('?foo=1')).toBeNull();
    expect(readSafeNext('?next=')).toBeNull();
  });

  it.each([
    '//evil.com',              // protocol-relative — navigates off-origin
    'https://evil.com',
    'http://evil.com',
    '/\\evil.com',             // backslash form some browsers normalise to //
    'javascript:alert(1)',
    'oauth/authorize',         // relative, not rooted
  ])('rejects %s', (candidate) => {
    expect(readSafeNext(`?next=${encodeURIComponent(candidate)}`)).toBeNull();
  });
});

// A history stack the size of the real one: entries carry their own state, so
// walking back exposes the depth stamp navigate() left on the earlier entry.
function installFakeWindow(entryHash = '') {
  const stack: Array<{ hash: string; state: unknown }> = [{ hash: entryHash, state: null }];
  let i = 0;
  const win = {
    location: {
      get hash() { return stack[i]!.hash; },
      set hash(v: string) {
        stack.length = i + 1;
        stack.push({ hash: v.startsWith('#') ? v : '#' + v, state: null });
        i++;
      },
    },
    history: {
      get state() { return stack[i]!.state; },
      replaceState(s: unknown) { stack[i]!.state = s; },
      back() { if (i > 0) i--; },
    },
  };
  globalThis.window = win as unknown as Window & typeof globalThis;
  return { hash: () => stack[i]!.hash };
}

describe('navigateBack', () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it('returns to the screen the user came from', () => {
    const w = installFakeWindow();
    navigate('/purchase-orders');
    navigate('/purchase-orders/PO-1372');
    navigateBack('/dashboard');
    expect(w.hash()).toBe('#/purchase-orders');
  });

  it('walks back one screen at a time', () => {
    const w = installFakeWindow();
    navigate('/dashboard');
    navigate('/purchase-orders');
    navigate('/purchase-orders/PO-1372');
    navigateBack('/dashboard');
    navigateBack('/dashboard');
    expect(w.hash()).toBe('#/dashboard');
  });

  // A deep-linked order has nothing of ours behind it — going back there would
  // step off the site entirely.
  it('uses the fallback when nothing of ours is behind', () => {
    const w = installFakeWindow('#/purchase-orders/PO-1372');
    navigateBack('/purchase-orders');
    expect(w.hash()).toBe('#/purchase-orders');
  });
});
