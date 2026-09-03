// Navigation timing for the load path, posted once per page load.
//
// The backend already logs its own handler time, and it is fast — that was
// never the question. What nobody could answer was how long the user waits
// before the app paints, which is why "sometimes it loads slowly" stayed a
// feeling for as long as it did. This is the other half of the picture:
// lib/errorToast.ts reports what broke, this reports what it cost.
//
// Numbers only. No paths, no ids beyond the session's own auth — a timing
// report should never be a place a URL can leak.

import { loadCallCounts, rawFetch } from './api';

// One per page load. A SPA route change is not a page load, and re-reporting on
// each one would drown the signal in noise.
let sent = false;

// null when the browser has no LCP support or nothing qualified before we sent.
let lcp: number | null = null;

function observeLcp(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    const obs = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) lcp = Math.round(last.startTime);
    });
    // buffered so an LCP that happened before this ran is not missed.
    obs.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    // Unsupported entry type. No LCP, and the rest of the report still stands.
  }
}

function report(): void {
  if (sent) return;
  const nav = performance.getEntriesByType('navigation')[0] as
    PerformanceNavigationTiming | undefined;
  if (!nav) return;
  sent = true;

  void rawFetch('POST', '/api/client-timings', {
    // Server think time plus the network to it — the part the backend's own
    // logs already cover, here for comparison against the rest.
    ttfb: Math.round(nav.responseStart - nav.requestStart),
    // The entry bundle downloaded and parsed.
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
    loadEvent: Math.round(nav.loadEventEnd - nav.startTime),
    lcp,
    // 'navigate' vs 'reload' vs 'back_forward' — a back_forward load is served
    // from the bfcache and its numbers mean something different.
    navType: nav.type,
    // Request fan-out for this load, counted in api.ts.
    ...loadCallCounts(),
    // A phone on 3G and a desktop on the office LAN are different populations;
    // without this the distribution is bimodal for no visible reason.
    downlink: (navigator as { connection?: { downlink?: number } }).connection?.downlink ?? null,
  }, undefined, { keepalive: true }).catch(() => {
    // A dropped timing report is not worth telling anyone about.
  });
}

/** Start observing, and arrange to report once. Call once, after render. */
export function installTiming(): void {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return;
  observeLcp();

  // LCP is not final until the user interacts or the page is hidden, so waiting
  // a little produces a truer number than reporting at `load`. Whichever comes
  // first wins, and `sent` makes the loser a no-op.
  const onHidden = () => { if (document.visibilityState === 'hidden') report(); };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('load', () => { setTimeout(report, 5_000); });
}
