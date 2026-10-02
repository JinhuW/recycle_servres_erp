import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  hrefFor, matchPoCheck, matchPurchaseOrder, navigate, navigateBack, onLinkClick, parseShippingRoute,
  pathToDesktopView, poCheckPath, readSafeNext, replaceRoute, type LinkClick,
} from './route';

describe('box check route', () => {
  it('is its own desktop route under the PO, not a phone screen', () => {
    expect(poCheckPath('PO-1448')).toBe('/purchase-orders/PO-1448/check');
    expect(matchPoCheck('/purchase-orders/PO-1448/check')).toEqual({ id: 'PO-1448' });
    expect(matchPoCheck('/purchase-orders/PO-1448')).toBeNull();
    expect(matchPurchaseOrder('/purchase-orders/PO-1448/check')).toBeNull();
    expect(pathToDesktopView('/purchase-orders/PO-1448/check')).toBe('history');
  });
});

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

  it('maps the web submissions inbox and one submission', () => {
    expect(pathToDesktopView('/web-submissions')).toBe('websubmissions');
    expect(pathToDesktopView('/web-submissions/WS-1001')).toBe('websubmissions');
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
    // The URL parser drops tab/LF/CR, so each of these resolves to //evil.com.
    '/\t/evil.com',
    '/\n/evil.com',
    '/\r/evil.com',
  ])('rejects %j', (candidate) => {
    expect(readSafeNext(`?next=${encodeURIComponent(candidate)}`)).toBeNull();
  });

  it('rejects the percent-encoded tab form as it arrives in the address bar', () => {
    expect(readSafeNext('?next=%2F%09%2Fevil.com')).toBeNull();
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
      replace(v: string) { stack[i] = { hash: v.startsWith('#') ? v : '#' + v, state: null }; },
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

// A redirect must not leave the page that bounced behind it, or Back lands
// there and bounces forward again.
describe('replaceRoute', () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it('takes the bounced entry\'s place, so Back skips it', () => {
    const w = installFakeWindow();
    navigate('/purchase-orders');
    navigate('/purchase-orders/PO-1/check');
    replaceRoute('/purchase-orders/PO-1');
    expect(w.hash()).toBe('#/purchase-orders/PO-1');
    navigateBack('/dashboard');
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

// A history that fires hashchange the way a browser does: after the change,
// not inside it (flush() delivers them), with old and new URLs.
function installEventedWindow(entryHash: string) {
  const stack: Array<{ hash: string; state: unknown }> = [{ hash: entryHash, state: null }];
  let i = 0;
  const queue: Array<{ oldURL: string; newURL: string }> = [];
  const url = (hash: string) => 'https://erp.test/' + hash;
  const hashOf = (u: string) => (u.includes('#') ? u.slice(u.indexOf('#')) : '');
  const norm = (v: string) => (v.startsWith('#') ? v : '#' + v);
  const move = (change: () => void) => {
    const before = url(stack[i]!.hash);
    change();
    const after = url(stack[i]!.hash);
    if (before !== after) queue.push({ oldURL: before, newURL: after });
  };
  const win = {
    location: {
      get hash() { return stack[i]!.hash; },
      set hash(v: string) {
        move(() => { stack.length = i + 1; stack.push({ hash: norm(v), state: null }); i++; });
      },
      replace(v: string) { move(() => { stack[i] = { hash: norm(v), state: null }; }); },
    },
    history: {
      get state() { return stack[i]!.state; },
      replaceState(s: unknown, _t: string, u?: string) {
        stack[i]!.state = s;
        if (u) stack[i]!.hash = hashOf(u);
      },
      pushState(s: unknown, _t: string, u: string) {
        stack.length = i + 1;
        stack.push({ hash: hashOf(u), state: s });
        i++;
      },
      back() { move(() => { if (i > 0) i--; }); },
      forward() { move(() => { if (i < stack.length - 1) i++; }); },
      go(delta: number) { move(() => { i = Math.min(stack.length - 1, Math.max(0, i + delta)); }); },
    },
    addEventListener() {},
  };
  globalThis.window = win as unknown as Window & typeof globalThis;
  return { win, queue, hash: () => stack[i]!.hash };
}

describe('leaving unsaved edits', () => {
  // The route module counts its own navigations; a fresh copy per test keeps
  // one test's count out of the next.
  let route: typeof import('./route');
  let w: ReturnType<typeof installEventedWindow>;
  const flush = () => {
    while (w.queue.length) route.onHashChange(w.queue.shift()!);
  };
  beforeEach(async () => {
    vi.resetModules();
    route = await import('./route');
    w = installEventedWindow('#/dashboard');
  });
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  function guard(answer: () => Promise<boolean>) {
    const asked: string[] = [];
    route.setLeaveGuard({
      wouldAsk: () => true,
      ask: (p) => { asked.push(p); return answer(); },
    });
    return asked;
  }
  const plainClick = (): LinkClick => ({
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    defaultPrevented: false, preventDefault() {}, stopPropagation() {},
  });

  it('asks before a link leaves, and stays on a no', async () => {
    const asked = guard(async () => false);
    let prevented = false;
    route.onLinkClick('/inventory')({ ...plainClick(), preventDefault() { prevented = true; } });
    expect(prevented).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual(['/inventory']);
    expect(w.hash()).toBe('#/dashboard');
  });

  it('follows the link on a yes', async () => {
    guard(async () => true);
    route.onLinkClick('/inventory')(plainClick());
    await new Promise((r) => setTimeout(r, 0));
    expect(w.hash()).toBe('#/inventory');
  });

  it('never asks for its own navigate(), which follows a save or an answered Cancel', () => {
    const asked = guard(async () => false);
    route.navigate('/purchase-orders');
    flush();
    expect(w.hash()).toBe('#/purchase-orders');
    expect(asked).toEqual([]);
  });

  it('undoes a Back while it asks, asks once, and goes back on a yes', async () => {
    route.navigate('/purchase-orders');
    route.navigate('/purchase-orders/PO-1');
    flush();
    let answer!: (ok: boolean) => void;
    const asked = guard(() => new Promise((r) => { answer = r; }));
    w.win.history.back();
    flush();
    expect(w.hash()).toBe('#/purchase-orders/PO-1');
    // A second Back while the dialog is up is undone without a second dialog.
    w.win.history.back();
    flush();
    expect(w.hash()).toBe('#/purchase-orders/PO-1');
    expect(asked).toEqual(['/purchase-orders']);
    answer(true);
    await new Promise((r) => setTimeout(r, 0));
    flush();
    expect(w.hash()).toBe('#/purchase-orders');
  });

  // A navigate() to the page already shown changes nothing, so it must not
  // leave a pass behind for the user's next Back.
  it('leaves no pass behind for a navigate() that changed nothing', () => {
    route.navigate('/purchase-orders');
    flush();
    route.navigate('/purchase-orders');
    const asked = guard(async () => false);
    w.win.history.back();
    flush();
    expect(asked).toEqual(['/dashboard']);
    expect(w.hash()).toBe('#/purchase-orders');
  });

  // A refused Forward used to be undone by pushing the page again after the
  // refused entry, which left that entry behind the page: the next in-app Back
  // landed on it with a pass, and the edits went unasked.
  it('keeps a refused Forward ahead of the page, not behind it', async () => {
    route.navigate('/purchase-orders');
    route.navigate('/inventory');
    flush();
    route.navigateBack('/dashboard');
    flush();
    const asked = guard(async () => false);
    w.win.history.forward();
    flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.hash()).toBe('#/purchase-orders');
    w.win.history.forward();
    flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.hash()).toBe('#/purchase-orders');
    expect(asked).toEqual(['/inventory', '/inventory']);
    route.navigateBack('/dashboard');
    flush();
    expect(w.hash()).toBe('#/dashboard');
  });

  it('keeps a refused typed address ahead of the page too', async () => {
    route.navigate('/purchase-orders');
    flush();
    const asked = guard(async () => false);
    w.win.location.hash = '#/clients';
    flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.hash()).toBe('#/purchase-orders');
    w.win.history.back();
    flush();
    expect(asked).toEqual(['/clients', '/dashboard']);
    expect(w.hash()).toBe('#/purchase-orders');
  });

  it('undoes a Back onto the first entry, and goes there on a yes', async () => {
    route.navigate('/purchase-orders');
    flush();
    let answer!: (ok: boolean) => void;
    const asked = guard(() => new Promise((r) => { answer = r; }));
    w.win.history.back();
    flush();
    expect(w.hash()).toBe('#/purchase-orders');
    expect(asked).toEqual(['/dashboard']);
    answer(true);
    await new Promise((r) => setTimeout(r, 0));
    flush();
    expect(w.hash()).toBe('#/dashboard');
  });

  // The history menu's long-press jumps several entries at once.
  it('steps a refused multi-entry Forward all the way back', async () => {
    route.navigate('/a');
    route.navigate('/b');
    route.navigate('/c');
    flush();
    route.navigateBack('/dashboard');
    flush();
    route.navigateBack('/dashboard');
    flush();
    expect(w.hash()).toBe('#/a');
    const asked = guard(async () => false);
    w.win.history.go(2);
    flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(w.hash()).toBe('#/a');
    // The screen is still /a's: Back asks about what is really behind it.
    w.win.history.back();
    flush();
    expect(asked).toEqual(['/c', '/dashboard']);
    expect(w.hash()).toBe('#/a');
  });

  it('lands on a Forward target with its query on a yes', async () => {
    route.navigate('/purchase-orders');
    route.navigate('/purchase-orders/PO-1?tab=payment');
    flush();
    route.navigateBack('/dashboard');
    flush();
    guard(async () => true);
    w.win.history.forward();
    flush();
    await new Promise((r) => setTimeout(r, 0));
    flush();
    expect(w.hash()).toBe('#/purchase-orders/PO-1?tab=payment');
  });

  // A reload restarts the module's counter while the stack keeps its numbers.
  it('still reads a Back as Back after a reload', async () => {
    route.navigate('/a');
    route.navigate('/b');
    route.navigate('/c');
    flush();
    route.navigateBack('/dashboard');
    flush();
    vi.resetModules();
    route = await import('./route');
    w.win.history.forward();
    flush();
    route.navigate('/e');
    flush();
    const asked = guard(async () => false);
    w.win.history.back();
    flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual(['/c']);
    expect(w.hash()).toBe('#/e');
  });

  it('lands on the Forward target on a yes', async () => {
    route.navigate('/purchase-orders');
    route.navigate('/inventory');
    flush();
    route.navigateBack('/dashboard');
    flush();
    expect(w.hash()).toBe('#/purchase-orders');
    guard(async () => true);
    w.win.history.forward();
    flush();
    await new Promise((r) => setTimeout(r, 0));
    flush();
    expect(w.hash()).toBe('#/inventory');
  });
});
