import { useEffect, useState } from 'react';
import type { ActivityArea } from '@recycle-erp/shared';

/**
 * Tiny hash-based router. No external deps. The app's "URL" is the part after
 * `#`, e.g. `#/purchase-orders/SO-1289` → path `/purchase-orders/SO-1289`.
 * Both mobile and desktop shells subscribe to this and react to changes.
 */

// A hash route may carry a query — `#/purchase-orders/PO-1/?tab=payment` — for
// page-local state a link should land on (the open tab). The path is what the
// router matches; the query never reaches it.
export function splitHash(hash: string): { path: string; query: string } {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = raw.indexOf('?');
  return q < 0 ? { path: raw, query: '' } : { path: raw.slice(0, q), query: raw.slice(q + 1) };
}

function readPath(): string {
  if (typeof window === 'undefined') return '/';
  const h = window.location.hash || '';
  if (h.startsWith('#')) return splitHash(h).path || '/';
  // OAuth consent lands on `/authorize?req=…` as a real path, not a hash
  // route — the backend redirects there from `/oauth/authorize`. Fall back to
  // pathname so the SPA can recognise that route on the cold load.
  const p = window.location.pathname || '/';
  if (p === '/authorize') return '/authorize';
  return '/';
}

// How many entries this app has pushed, stamped onto each one. A back button
// can then step through the real browser history (which restores the previous
// screen's scroll position) when there is an entry of ours behind it, and fall
// back to a path when there isn't — an order opened from a shared link or a
// cold load has nothing behind it but the site the user came from.
function historyDepth(): number {
  const s = window.history.state as { erpDepth?: number } | null;
  return typeof s?.erpDepth === 'number' ? s.erpDepth : 0;
}

// Each entry the app shows or leaves also carries a sequence number, handed out
// in the order entries are made, so it rises along the history stack. The entry
// a hash change lands on against the one on screen tells Back from Forward; an
// entry with none is one the browser has just added ahead of the screen (a
// typed address, a plain link).
let lastSeq = 0;

function seqOf(state: unknown): number | null {
  const s = (state as { erpSeq?: number } | null)?.erpSeq;
  return typeof s === 'number' ? s : null;
}

// A reload restarts the counter while the stack keeps its numbers; catching up
// on every entry seen keeps a new one from repeating an old one's.
function catchUpSeq(): void {
  lastSeq = Math.max(lastSeq, seqOf(window.history.state) ?? 0);
}

function stampSeq(): void {
  catchUpSeq();
  if (seqOf(window.history.state) !== null) return;
  window.history.replaceState({ ...(window.history.state ?? {}), erpSeq: ++lastSeq }, '');
}

// Leaving a screen with unsaved edits asks first. The check is installed by
// lib/unsavedGuard, so routing knows nothing about edits; with none installed
// every navigation goes through. `wouldAsk` answers synchronously, because a
// Back already under way has to be undone before the dialog opens.
export type LeaveGuard = {
  wouldAsk(nextPath: string): boolean;
  ask(nextPath: string): Promise<boolean>;
};
let leaveGuard: LeaveGuard | null = null;

export function setLeaveGuard(guard: LeaveGuard | null): void {
  leaveGuard = guard;
}

// Hash changes this module started. They pass the guard: whoever calls
// navigate() has asked already, or has just saved. Counted, not flagged, since
// two can be made before the first one's event arrives.
let selfNavs = 0;

export function navigate(path: string): void {
  const target = path.startsWith('/') ? path : '/' + path;
  // Avoid setting the same hash twice — that would emit a redundant
  // hashchange event and cause downstream effects to fire pointlessly. The
  // path decides: a page that only changed its own query is still that page.
  if (splitHash(window.location.hash).path === splitHash(target).path) return;
  const depth = historyDepth() + 1;
  stampSeq();
  selfNavs++;
  window.location.hash = target;
  // The hash assignment has already pushed the entry, so this stamps the one
  // we just landed on, not the one we left.
  window.history.replaceState({ ...(window.history.state ?? {}), erpDepth: depth, erpSeq: ++lastSeq }, '');
}

/** Like `navigate`, but the new route takes the current history entry's place —
 *  for a redirect, so Back doesn't land on the page that bounced. */
export function replaceRoute(path: string): void {
  const target = path.startsWith('/') ? path : '/' + path;
  if (splitHash(window.location.hash).path === splitHash(target).path) return;
  const depth = historyDepth();
  catchUpSeq();
  const seq = seqOf(window.history.state) ?? ++lastSeq;
  selfNavs++;
  window.location.replace('#' + target);
  // replace() drops the entry's state; keep the depth and place the entry
  // already had.
  window.history.replaceState({ ...(window.history.state ?? {}), erpDepth: depth, erpSeq: seq }, '');
}

/** The current route's query, e.g. `tab=payment`. */
export function readHashQuery(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(splitHash(window.location.hash).query);
}

/** Rewrites the route's query in place — no history entry, no hashchange
 *  the shells react to — so page-local state such as the open tab survives a
 *  reload and travels in a copied link. Empty params drop the `?`. */
export function replaceHashQuery(params: URLSearchParams): void {
  const { path } = splitHash(window.location.hash);
  const q = params.toString();
  const next = '#' + path + (q ? '?' + q : '');
  if (next === window.location.hash) return;
  window.history.replaceState(window.history.state, '', next);
}

/** Back to wherever the user came from, or `fallback` when that's off-site. */
export function navigateBack(fallback: string): void {
  if (historyDepth() > 0) {
    selfNavs++;
    window.history.back();
    return;
  }
  navigate(fallback);
}

// One hashchange listener for the whole app, so a change the guard refuses is
// refused once, before any shell re-renders.
const routeSubscribers = new Set<() => void>();
let listening = false;
// The entry the app is showing, for putting it back when a change is refused.
let shownState: unknown = null;
let askingToLeave = false;
// A refused Forward or typed address being stepped back off: `toSeq` is the
// entry on screen, `then` a target the user has agreed to go to since.
let undo: { toSeq: number; then: string | null } | null = null;

function acceptRoute(): void {
  stampSeq();
  shownState = window.history.state;
  for (const notify of routeSubscribers) notify();
}

/** Exported for tests; the app reaches it through useRoute(). */
export function onHashChange(e: { oldURL: string; newURL: string }): void {
  if (undo) {
    // A Forward can jump several entries; step until the screen's own is back.
    const seq = seqOf(window.history.state);
    if (seq === null || seq > undo.toSeq) {
      window.history.back();
      return;
    }
    const then = undo.then;
    undo = null;
    if (then !== null) navigate(then);
    return;
  }
  if (selfNavs > 0) {
    selfNavs--;
    acceptRoute();
    return;
  }
  // Back, Forward, or a typed address. Undo it while the user is asked, so the
  // address bar and the screen keep agreeing; a second one while the dialog is
  // up is undone without asking again.
  const next = readPath();
  if (!askingToLeave && !leaveGuard?.wouldAsk(next)) {
    acceptRoute();
    return;
  }
  const landedSeq = seqOf(window.history.state);
  const shownSeq = seqOf(shownState);
  // With nothing accepted yet there is no direction to go on; putting the
  // screen's entry back on top is right for Back and harmless otherwise.
  const wentBack = shownSeq === null || (landedSeq !== null && landedSeq < shownSeq);
  if (wentBack) {
    window.history.pushState(shownState, '', e.oldURL);
  } else {
    // Forward or a new entry: step back onto the screen's own entry, so the
    // refused one stays ahead of it. A copy pushed after it (as for Back) left
    // it behind the screen, for the next in-app Back to land on unasked.
    undo = { toSeq: shownSeq, then: null };
    window.history.back();
  }
  if (askingToLeave || !leaveGuard) return;
  askingToLeave = true;
  const hashAt = e.newURL.indexOf('#');
  const target = hashAt < 0 ? '/' : e.newURL.slice(hashAt + 1);
  void leaveGuard.ask(next).then((ok) => {
    askingToLeave = false;
    if (!ok) return;
    if (wentBack) {
      // Back: step onto the real entry, which keeps its scroll position.
      selfNavs++;
      window.history.back();
      return;
    }
    // Forward or a typed address: go where it was headed, once the undo is
    // done if a quick answer beat it.
    if (undo) undo.then = target;
    else navigate(target);
  });
}

function subscribeRoute(notify: () => void): () => void {
  if (!listening) {
    listening = true;
    stampSeq();
    shownState = window.history.state;
    window.addEventListener('hashchange', onHashChange);
  }
  routeSubscribers.add(notify);
  return () => { routeSubscribers.delete(notify); };
}

export function useRoute(): { path: string } {
  const [path, setPath] = useState<string>(readPath);
  useEffect(() => subscribeRoute(() => setPath(readPath())), []);
  return { path };
}

/**
 * Returns the params object if `template` (e.g. `/purchase-orders/:id`)
 * matches `path`, or null otherwise. Trailing segments in `path` are not
 * allowed unless the template's last segment is a param.
 */
/**
 * The phone shows a PO on two screens: the order itself at
 * `/purchase-orders/:id` and its lines at `/purchase-orders/:id/products`.
 * Both map to the same PO; `matchPurchaseOrder` answers "which PO, which
 * screen" for every shell so the desktop, which has one page, still opens the
 * PO when handed the products link.
 */
export type PoScreen = 'info' | 'products';

export function poProductsPath(id: string): string {
  return '/purchase-orders/' + id + '/products';
}

export function matchPurchaseOrder(path: string): { id: string; screen: PoScreen } | null {
  const info = match('/purchase-orders/:id', path);
  if (info) return { id: info.id!, screen: 'info' };
  const products = match('/purchase-orders/:id/products', path);
  if (products) return { id: products.id!, screen: 'products' };
  return null;
}

// Box check is desktop-only, so it is kept out of PoScreen: the phone never
// has to learn a screen it cannot show.
export function poCheckPath(id: string): string {
  return '/purchase-orders/' + id + '/check';
}

export function matchPoCheck(path: string): { id: string } | null {
  const m = match('/purchase-orders/:id/check', path);
  return m ? { id: m.id! } : null;
}

export function match(template: string, path: string): Record<string, string> | null {
  const t = template.split('/').filter(Boolean);
  const p = path.split('/').filter(Boolean);
  if (t.length !== p.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    const seg = t[i]!;
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(p[i]!);
    } else if (seg !== p[i]) {
      return null;
    }
  }
  return params;
}

// Shipping sub-routes. Parsed here (not ad-hoc in the shell) so the two
// shells agree on which paths belong to the Shipping page.
export type ShippingRoute =
  | { kind: 'dashboard' }
  | { kind: 'addLabel' };

export function parseShippingRoute(path: string): ShippingRoute | null {
  if (path === '/shipping') return { kind: 'dashboard' };
  if (path === '/shipping/add') return { kind: 'addLabel' };
  return null;
}

// Desktop view ids ↔ URL paths. Source of truth for the sidebar/router.
export const DESKTOP_VIEW_TO_PATH = {
  dashboard:  '/dashboard',
  submit:     '/submit',
  history:    '/purchase-orders',
  shipping:   '/shipping',
  clients:    '/clients',
  market:     '/market',
  inventory:  '/inventory',
  analysis:   '/inventory/analysis',
  sellorders: '/sell-orders',
  transfers:  '/transfers',
  websubmissions: '/web-submissions',
  activity:   '/activity',
  payments:   '/payments',
  internaltx: '/payments/internal',
  tracker:    '/tracker',
  coordinator: '/fleet',
  settings:   '/settings',
} as const;

export type DesktopViewId = keyof typeof DESKTOP_VIEW_TO_PATH;

export function pathToDesktopView(path: string): DesktopViewId {
  if (path === '/' || path === '/dashboard') return 'dashboard';
  if (path === '/submit') return 'submit';
  if (path === '/purchase-orders' || matchPurchaseOrder(path) || matchPoCheck(path)) return 'history';
  if (parseShippingRoute(path)) return 'shipping';
  if (path === '/clients' || match('/clients/:id', path)) return 'clients';
  if (path === '/market') return 'market';
  // Analysis is a tab under Inventory — match it before the /inventory/:id edit
  // route so it isn't read as an item id.
  if (path === '/inventory/analysis') return 'analysis';
  if (path === '/inventory' || match('/inventory/:id', path)) return 'inventory';
  if (path === '/sell-orders' || match('/sell-orders/:id', path) || match('/sell-orders/:id/edit', path)) return 'sellorders';
  if (path === '/transfers') return 'transfers';
  if (path === '/web-submissions' || match('/web-submissions/:id', path)) return 'websubmissions';
  if (path === '/activity') return 'activity';
  // A tab under Payments, like Analysis under Inventory.
  if (path === '/payments/internal') return 'internaltx';
  if (path === '/payments' || match('/payments/po/:id', path)) return 'payments';
  if (path === '/tracker') return 'tracker';
  if (path === '/fleet' || matchFleetWatch(path)) return 'coordinator';
  if (path === '/settings') return 'settings';
  return 'dashboard';
}

// The fleet page's live-browser viewer for one Facebook worker. A sub-route of
// /fleet (same view, same sidebar entry) so the back button returns to the
// fleet with its filters intact.
export function fleetWatchPath(workerId: string): string {
  return `/fleet/watch/${encodeURIComponent(workerId)}`;
}

export function matchFleetWatch(path: string): { workerId: string } | null {
  const m = match('/fleet/watch/:workerId', path);
  return m?.workerId ? { workerId: m.workerId } : null;
}

// The Payments page focused on one PO's linked payments. A path for
// navigate(); the page reads the id back with match('/payments/po/:id').
// With a transaction id the page opens that row instead of the first.
export function paymentsForOrderPath(orderId: string, txnId?: string): string {
  const base = `/payments/po/${encodeURIComponent(orderId)}`;
  return txnId ? `${base}?txn=${encodeURIComponent(txnId)}` : base;
}

// An in-app anchor's href. Anchors — unlike navigate() — need the `#` written
// out: a bare `/purchase-orders/<id>` is a real navigation, and the index.html
// served back has no hash, so the shell resolves it to the dashboard instead
// of the record.
export function hrefFor(path: string): string {
  return '#' + (path.startsWith('/') ? path : '/' + path);
}

// Structural, so this module stays free of React types.
export type LinkClick = {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};

// Click handler for an in-app anchor. A plain left-click routes through
// navigate() so the back-button depth stamp stays right; ⌘/ctrl/shift/alt or
// a non-left button is left to the browser, which opens the tab or window
// like it would for any link. Propagation stops either way — a link inside a
// clickable row must never also toggle the row. `onNavigate` is for in-page
// side effects (closing a sheet) that must not run when the link opens
// elsewhere.
export function onLinkClick(path: string, onNavigate?: () => void): (e: LinkClick) => void {
  return (e) => {
    e.stopPropagation();
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // Before anything async, or the anchor's own href navigates as well.
    e.preventDefault();
    const go = () => {
      onNavigate?.();
      navigate(path);
    };
    if (!leaveGuard?.wouldAsk(path)) {
      go();
      return;
    }
    void leaveGuard.ask(path).then((ok) => { if (ok) go(); });
  };
}

// Deep link from an activity row back to the record it describes.
// Null when the event has no target to open.
export function activityRecordHref(area: ActivityArea, targetRef: string | null): string | null {
  if (area === 'price') return hrefFor('/market');
  if (!targetRef) return null;
  const base = area === 'po' ? '/purchase-orders/'
    : area === 'so' ? '/sell-orders/'
    : '/inventory/';
  return hrefFor(base + encodeURIComponent(targetRef));
}

// OAuth consent screen — a real-path route (not hash) because the backend
// redirects to it from `/oauth/authorize`. Kept off DESKTOP_VIEW_TO_PATH so
// it stays out of the sidebar and the DesktopView discriminant.
export function isAuthorizePath(path: string): boolean {
  return path === '/authorize';
}

// Post-login continuation for the OAuth bounce: `/oauth/authorize` sends an
// unauthenticated (or expired) caller to `/login?next=…`, and without
// something reading `next` back the user lands on the dashboard and the
// connector's popup waits forever.
//
// Only same-origin absolute paths are honoured, so an attacker-supplied `next`
// can't turn the login page into an open redirect. `//host` and `/\host` are
// protocol-relative forms that navigate off-origin. Prefix checks alone are
// not enough: the URL parser drops tab, CR and LF anywhere in the string, so
// `/\t/evil.com` passes a `//` test and still lands on //evil.com. Control
// characters and backslashes are refused outright, and the survivor is
// resolved against a placeholder origin and must still be on it — the
// returned path is the parser's reading, not the raw input.
const UNSAFE_NEXT_CHARS = /[\x00-\x1f\\]/;
const NEXT_BASE_ORIGIN = 'https://erp.invalid';

export function readSafeNext(search: string): string | null {
  const raw = new URLSearchParams(search).get('next');
  if (!raw) return null;
  if (UNSAFE_NEXT_CHARS.test(raw)) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  const u = new URL(raw, NEXT_BASE_ORIGIN);
  if (u.origin !== NEXT_BASE_ORIGIN) return null;
  return u.pathname + u.search + u.hash;
}

// Mobile view ids ↔ URL paths.
export const MOBILE_VIEW_TO_PATH = {
  dashboard: '/dashboard',
  history:   '/purchase-orders',
  shipping:  '/shipping',
  market:    '/market',
  inventory: '/inventory',
  me:        '/profile',
} as const;

export type MobileViewId = keyof typeof MOBILE_VIEW_TO_PATH;

export function pathToMobileView(path: string): MobileViewId {
  if (path === '/' || path === '/dashboard') return 'dashboard';
  if (path === '/purchase-orders' || matchPurchaseOrder(path)) return 'history';
  if (parseShippingRoute(path)) return 'shipping';
  if (path === '/market') return 'market';
  if (path === '/inventory') return 'inventory';
  if (path === '/profile') return 'me';
  return 'dashboard';
}
