import { useEffect, useState } from 'react';
import type { ActivityArea } from '@recycle-erp/shared';

/**
 * Tiny hash-based router. No external deps. The app's "URL" is the part after
 * `#`, e.g. `#/purchase-orders/SO-1289` → path `/purchase-orders/SO-1289`.
 * Both mobile and desktop shells subscribe to this and react to changes.
 */

function readPath(): string {
  if (typeof window === 'undefined') return '/';
  const h = window.location.hash || '';
  if (h.startsWith('#')) return h.slice(1) || '/';
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

export function navigate(path: string): void {
  const target = path.startsWith('/') ? path : '/' + path;
  // Avoid setting the same hash twice — that would emit a redundant
  // hashchange event and cause downstream effects to fire pointlessly.
  if (window.location.hash === '#' + target) return;
  const depth = historyDepth() + 1;
  window.location.hash = target;
  // The hash assignment has already pushed the entry, so this stamps the one
  // we just landed on, not the one we left.
  window.history.replaceState({ ...(window.history.state ?? {}), erpDepth: depth }, '');
}

/** Back to wherever the user came from, or `fallback` when that's off-site. */
export function navigateBack(fallback: string): void {
  if (historyDepth() > 0) {
    window.history.back();
    return;
  }
  navigate(fallback);
}

export function useRoute(): { path: string } {
  const [path, setPath] = useState<string>(readPath);
  useEffect(() => {
    const onChange = () => setPath(readPath());
    window.addEventListener('hashchange', onChange);
    return () => { window.removeEventListener('hashchange', onChange); };
  }, []);
  return { path };
}

/**
 * Returns the params object if `template` (e.g. `/purchase-orders/:id`)
 * matches `path`, or null otherwise. Trailing segments in `path` are not
 * allowed unless the template's last segment is a param.
 */
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

// Shipping sub-routes. Parsed here (not ad-hoc in the shell) because
// `/shipping/new` would otherwise be captured by the `/shipping/:orderId`
// template as an order id — order of the checks is load-bearing.
export type ShippingRoute =
  | { kind: 'dashboard' }
  | { kind: 'wizardNew' }
  | { kind: 'addLabel' }
  | { kind: 'wizardPo'; orderId: string; sid: string | null }
  | { kind: 'focus'; orderId: string };

export function parseShippingRoute(path: string): ShippingRoute | null {
  if (path === '/shipping') return { kind: 'dashboard' };
  if (path === '/shipping/new') return { kind: 'wizardNew' };
  if (path === '/shipping/add') return { kind: 'addLabel' };
  const cont = match('/shipping/:orderId/label/:sid', path);
  if (cont) return { kind: 'wizardPo', orderId: cont.orderId!, sid: cont.sid! };
  const fresh = match('/shipping/:orderId/label', path);
  if (fresh) return { kind: 'wizardPo', orderId: fresh.orderId!, sid: null };
  const focus = match('/shipping/:orderId', path);
  if (focus) return { kind: 'focus', orderId: focus.orderId! };
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
  vendorbids: '/vendor-bids',
  transfers:  '/transfers',
  activity:   '/activity',
  payments:   '/payments',
  tracker:    '/tracker',
  coordinator: '/fleet',
  settings:   '/settings',
} as const;

export type DesktopViewId = keyof typeof DESKTOP_VIEW_TO_PATH;

export function pathToDesktopView(path: string): DesktopViewId {
  if (path === '/' || path === '/dashboard') return 'dashboard';
  if (path === '/submit') return 'submit';
  if (path === '/purchase-orders' || match('/purchase-orders/:id', path)) return 'history';
  if (parseShippingRoute(path)) return 'shipping';
  if (path === '/clients' || match('/clients/:id', path)) return 'clients';
  if (path === '/market') return 'market';
  // Analysis is a tab under Inventory — match it before the /inventory/:id edit
  // route so it isn't read as an item id.
  if (path === '/inventory/analysis') return 'analysis';
  if (path === '/inventory' || match('/inventory/:id', path)) return 'inventory';
  if (path === '/sell-orders' || match('/sell-orders/:id', path) || match('/sell-orders/:id/edit', path)) return 'sellorders';
  if (path === '/vendor-bids' || match('/vendor-bids/:id', path)) return 'vendorbids';
  if (path === '/transfers') return 'transfers';
  if (path === '/activity') return 'activity';
  if (path === '/payments') return 'payments';
  if (path === '/tracker') return 'tracker';
  if (path === '/fleet') return 'coordinator';
  if (path === '/settings') return 'settings';
  return 'dashboard';
}

// Deep link from an activity row back to the record it describes. Anchors —
// unlike navigate() — need the `#` written out: a bare `/purchase-orders/<id>`
// is a real navigation, and the index.html served back has no hash, so the
// shell resolves it to the dashboard instead of the record.
// Null when the event has no target to open.
export function activityRecordHref(area: ActivityArea, targetRef: string | null): string | null {
  if (area === 'price') return '#/market';
  if (!targetRef) return null;
  const base = area === 'po' ? '/purchase-orders/'
    : area === 'so' ? '/sell-orders/'
    : '/inventory/';
  return '#' + base + encodeURIComponent(targetRef);
}

// OAuth consent screen — a real-path route (not hash) because the backend
// redirects to it from `/oauth/authorize`. Kept off DESKTOP_VIEW_TO_PATH so
// it stays out of the sidebar and the DesktopView discriminant.
export function isAuthorizePath(path: string): boolean {
  return path === '/authorize';
}

// Post-login continuation for the OAuth bounce: `/oauth/authorize` sends an
// unauthenticated (or 15-min-expired) caller to `/login?next=…`, and without
// something reading `next` back the user lands on the dashboard and the
// connector's popup waits forever.
//
// Only same-origin absolute paths are honoured. `//host` and `/\host` are
// browser-relative-protocol forms that would navigate off-origin, so an
// attacker-supplied `next` can't turn the login page into an open redirect.
export function readSafeNext(search: string): string | null {
  const raw = new URLSearchParams(search).get('next');
  if (!raw) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null;
  return raw;
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
  if (path === '/purchase-orders' || match('/purchase-orders/:id', path)) return 'history';
  if (parseShippingRoute(path)) return 'shipping';
  if (path === '/market') return 'market';
  if (path === '/inventory') return 'inventory';
  if (path === '/profile') return 'me';
  return 'dashboard';
}
