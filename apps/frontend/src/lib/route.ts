import { useEffect, useState } from 'react';

/**
 * Tiny hash-based router. No external deps. The app's "URL" is the part after
 * `#`, e.g. `#/purchase-orders/SO-1289` → path `/purchase-orders/SO-1289`.
 * Both mobile and desktop shells subscribe to this and react to changes.
 */

function readPath(): string {
  if (typeof window === 'undefined') return '/';
  const h = window.location.hash || '';
  return h.startsWith('#') ? h.slice(1) || '/' : '/';
}

export function navigate(path: string): void {
  const target = path.startsWith('/') ? path : '/' + path;
  // Avoid setting the same hash twice — that would emit a redundant
  // hashchange event and cause downstream effects to fire pointlessly.
  if (window.location.hash === '#' + target) return;
  window.location.hash = target;
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

// Desktop view ids ↔ URL paths. Source of truth for the sidebar/router.
export const DESKTOP_VIEW_TO_PATH = {
  dashboard:  '/dashboard',
  submit:     '/submit',
  history:    '/purchase-orders',
  market:     '/market',
  inventory:  '/inventory',
  sellorders: '/sell-orders',
  settings:   '/settings',
} as const;

export type DesktopViewId = keyof typeof DESKTOP_VIEW_TO_PATH;

export function pathToDesktopView(path: string): DesktopViewId {
  if (path === '/' || path === '/dashboard') return 'dashboard';
  if (path === '/submit') return 'submit';
  if (path === '/purchase-orders' || match('/purchase-orders/:id', path)) return 'history';
  if (path === '/market') return 'market';
  if (path === '/inventory' || match('/inventory/:id', path)) return 'inventory';
  if (
    path === '/sell-orders' ||
    match('/sell-orders/:id', path) ||
    match('/sell-orders/:id/edit', path)
  ) return 'sellorders';
  if (path === '/settings') return 'settings';
  return 'dashboard';
}

// Mobile view ids ↔ URL paths.
export const MOBILE_VIEW_TO_PATH = {
  dashboard: '/dashboard',
  history:   '/purchase-orders',
  market:    '/market',
  inventory: '/inventory',
  me:        '/profile',
} as const;

export type MobileViewId = keyof typeof MOBILE_VIEW_TO_PATH;

export function pathToMobileView(path: string): MobileViewId {
  if (path === '/' || path === '/dashboard') return 'dashboard';
  if (path === '/purchase-orders' || match('/purchase-orders/:id', path)) return 'history';
  if (path === '/market') return 'market';
  if (path === '/inventory') return 'inventory';
  if (path === '/profile') return 'me';
  return 'dashboard';
}
