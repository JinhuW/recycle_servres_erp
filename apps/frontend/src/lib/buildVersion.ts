// Tells a desktop tab that a deploy has replaced the bundle it is running.
//
// The phone shell learns of a deploy through its service worker (lib/pwa.ts);
// the desktop shell has none, so a tab left open runs the old build until
// someone happens to reload it. The build writes its version into the bundle
// and into /version.json beside it (vite.config.ts); the two disagreeing means
// a newer build is live.

export const BUNDLE_VERSION: string = __APP_VERSION__;

export const BUNDLE_STALE_EVENT = 'app:bundleStale';

const MIN_GAP_MS = 5 * 60 * 1000;
// Finer than the gap, so timer drift or a throttled background tab can't push
// a due check a whole extra gap later.
const TICK_MS = 60 * 1000;

let stale = false;

// The update toast is lazy-loaded, so it reads the flag on mount as well as
// listening for the event.
export function bundleStale(): boolean {
  return stale;
}

// A static file from the Worker's asset layer, not an /api call, so none of
// lib/api.ts's CSRF or refresh handling applies. Never throws: the Vite dev
// server has no such file and answers with index.html, which fails the parse
// and reads as "unknown".
export async function fetchLiveVersion(): Promise<unknown> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null
      ? (body as { version?: unknown }).version
      : undefined;
  } catch {
    return undefined;
  }
}

// Only a version that was actually read counts: an unreadable answer must
// never prompt a reload, or a broken deploy would loop every tab.
export function isStale(bundle: string, live: unknown): boolean {
  return typeof live === 'string' && live !== '' && live !== bundle;
}

// Checks when the tab comes back into view and on a timer while it is in view,
// at most once per gap. The page load counts as the first check. Returns a
// stop function.
export function watchBundleVersion(): () => void {
  let lastCheck = Date.now();
  const check = () => {
    if (stale || document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastCheck < MIN_GAP_MS) return;
    lastCheck = now;
    void fetchLiveVersion().then((live) => {
      if (stale || !isStale(BUNDLE_VERSION, live)) return;
      stale = true;
      window.dispatchEvent(new CustomEvent(BUNDLE_STALE_EVENT));
    });
  };
  document.addEventListener('visibilitychange', check);
  const timer = setInterval(check, TICK_MS);
  return () => {
    document.removeEventListener('visibilitychange', check);
    clearInterval(timer);
  };
}
