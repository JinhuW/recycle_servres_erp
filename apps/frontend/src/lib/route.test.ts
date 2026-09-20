import { describe, it, expect, afterEach } from 'vitest';
import { hrefFor, navigate, navigateBack, onLinkClick, parseShippingRoute, pathToDesktopView, readSafeNext, type LinkClick } from './route';

describe('parseShippingRoute', () => {
  it('parses the dashboard and the add-label routes', () => {
    expect(parseShippingRoute('/shipping')).toEqual({ kind: 'dashboard' });
    expect(parseShippingRoute('/shipping/add')).toEqual({ kind: 'addLabel' });
  });

  it('returns null off the shipping tree', () => {
    expect(parseShippingRoute('/purchase-orders/PO-1372')).toBeNull();
    expect(parseShippingRoute('/shipping/PO-1372')).toBeNull();
  });

  it('keeps every shipping shape on the shipping view', () => {
    for (const p of ['/shipping', '/shipping/add']) {
      expect(pathToDesktopView(p)).toBe('shipping');
    }
  });

  // Internal transactions is a tab under Payments — its own view, so the page
  // renders, but the sidebar keeps Payments lit.
  it('separates the internal-transactions tab from the payments list', () => {
    expect(pathToDesktopView('/payments')).toBe('payments');
    expect(pathToDesktopView('/payments/internal')).toBe('internaltx');
    // A PO's deep link is the payments list, focused — same view, same sidebar.
    expect(pathToDesktopView('/payments/po/PO-1372')).toBe('payments');
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

describe('hrefFor', () => {
  it('writes the hash out so the anchor stays in-app', () => {
    expect(hrefFor('/purchase-orders/PO-1438')).toBe('#/purchase-orders/PO-1438');
    expect(hrefFor('inventory')).toBe('#/inventory');
  });
});

// An anchor routes in place on a plain click and is left to the browser
// otherwise, so ⌘-click / middle-click open a tab the way any link does.
describe('onLinkClick', () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  function click(over: Partial<LinkClick> = {}) {
    const calls = { prevented: 0, stopped: 0 };
    const e: LinkClick = {
      button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false,
      preventDefault() { calls.prevented++; },
      stopPropagation() { calls.stopped++; },
      ...over,
    };
    return { e, calls };
  }

  it('routes a plain left-click through navigate()', () => {
    const w = installFakeWindow();
    const { e, calls } = click();
    let sideEffects = 0;
    onLinkClick('/inventory', () => { sideEffects++; })(e);
    expect(w.hash()).toBe('#/inventory');
    expect(calls).toEqual({ prevented: 1, stopped: 1 });
    expect(sideEffects).toBe(1);
  });

  it.each([
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['middle button', { button: 1 }],
    ['already handled', { defaultPrevented: true }],
  ] as const)('leaves a %s click to the browser', (_label, over) => {
    const w = installFakeWindow('#/dashboard');
    const { e, calls } = click(over);
    let sideEffects = 0;
    onLinkClick('/inventory', () => { sideEffects++; })(e);
    expect(w.hash()).toBe('#/dashboard');
    expect(calls).toEqual({ prevented: 0, stopped: 1 });
    expect(sideEffects).toBe(0);
  });
});
