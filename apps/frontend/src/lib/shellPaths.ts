// The real paths the app shell lives at. The app is hash-routed, so every
// screen is `/#/<route>` — a document path outside this list is not a page of
// ours, and answering it with index.html let the hash render a real screen
// under a URL that does not exist (`/vnc/homelab-1#/fleet` showed Fleet, RS-167).
//
// Shared by the Cloudflare Worker (deploy/cloudflare/worker.js — wrangler
// bundles this import) and the service worker's navigation fallback (sw.ts),
// so the edge and an installed client agree on what is a 404. Keep it free of
// imports: the Worker bundle must not pull in app code.
export const SHELL_PATHS: readonly string[] = [
  '/',
  // OAuth consent: the backend's /oauth/authorize 302s here (route.ts readPath).
  '/authorize',
  // Web Share Target landing the service worker 303s to after the POST.
  '/share-target',
  // PWA manifest shortcuts (vite.config.ts). Installed apps launch them as-is.
  '/submit',
  '/inventory',
  '/sell-orders',
];

export function isShellPath(pathname: string): boolean {
  return SHELL_PATHS.includes(pathname);
}

// The same list as Workbox NavigationRoute allowlist patterns. Workbox tests
// them against pathname + search, so a query (/authorize?req=…) must match.
export function shellNavigationAllowlist(): RegExp[] {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return SHELL_PATHS.map((p) => new RegExp(`^${escape(p)}(?:\\?|$)`));
}
