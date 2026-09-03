// Recovery for a deploy that lands while a tab is open.
//
// Chunk filenames are content-hashed, so a deploy replaces the asset manifest
// and the names this page holds stop existing. Every `lazy(() => import(...))`
// in the app then rejects, Suspense never resolves, and the user watches a
// skeleton — the shape "sometimes the page loads slow" actually took.
//
// Vite already reports this: the `__vitePreload` helper wraps every dynamic
// import and dispatches `vite:preloadError` on window when one fails, including
// for chunks with no preload dependencies. So one listener covers all of them,
// and any `lazy()` added later comes along for free — no per-call-site wrapper
// to remember.

const KEY = 'erp.chunkReloadAt';

// Long enough that the reload and its own chunk fetches finish inside it, short
// enough that the next deploy months from now gets its own attempt. A stored
// timestamp rather than a set-and-clear flag: a listener has no "import
// succeeded" moment to clear a flag on, so a flag would be left set forever and
// send the next such user straight to the error screen.
const GUARD_MS = 60_000;

type StampStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether a chunk failure should trigger a reload, recording the attempt when
 * it should. Pure but for the storage it is handed, so the decision is testable
 * without a DOM.
 */
export function shouldReload(store: StampStore, now: number): boolean {
  let previous: number | null = null;
  try {
    const raw = store.getItem(KEY);
    previous = raw === null ? null : Number(raw);
  } catch {
    // Storage can throw outright in a partitioned or locked-down context.
    // Treat it as "never reloaded" — one wasted reload beats a dead page.
  }

  // NaN from a hand-edited value fails this comparison, which is the safe way
  // round: it reads as "no recent attempt".
  if (previous !== null && now - previous < GUARD_MS) return false;

  try {
    store.setItem(KEY, String(now));
  } catch { /* see above — proceed without the guard rather than not at all */ }
  return true;
}

/**
 * Wire the listener. Call once, before the app renders.
 *
 * Deliberately does not `preventDefault()`: that only suppresses Vite's
 * rethrow, and `lazy` would then be handed `undefined` and throw anyway. Letting
 * it through means a genuine failure — one the reload does not fix — still
 * reaches the ErrorBoundary, which reports it and offers its own Reload.
 */
export function installChunkReload(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', () => {
    if (shouldReload(window.sessionStorage, Date.now())) {
      // sessionStorage is per-tab and survives the reload; the hash route the
      // user was on survives it too, so they land back where they were.
      window.location.reload();
    }
  });
}
