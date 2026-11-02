import { useSyncExternalStore } from 'react';
import { api } from './api';

// ─── Sidebar badge ────────────────────────────────────────────────────────────
// Submissions nobody has triaged yet. They arrive from the public forms, not
// from this app, so the count polls while the tab is visible and re-reads when
// it comes back. A triage on the page fires WEBSUB_CHANGED for an immediate
// read.

const WEBSUB_CHANGED = 'websub-changed';
const POLL_MS = 60_000;
let count = 0;
let reading = false;
let stale = false;
let timer = 0;
const readers = new Set<() => void>();

function readCount() {
  if (reading) { stale = true; return; }
  reading = true;
  api.get<{ n: number }>('/api/web-submissions/count')
    // A badge that fails to load stays as it was; it is never worth a dialog.
    .then(r => { count = r.n; for (const l of readers) l(); }, () => {})
    .finally(() => {
      reading = false;
      if (stale) { stale = false; readCount(); }
    });
}

const readIfVisible = () => { if (document.visibilityState === 'visible') readCount(); };

function watchCount(onChange: () => void) {
  if (readers.size === 0) {
    window.addEventListener(WEBSUB_CHANGED, readCount);
    document.addEventListener('visibilitychange', readIfVisible);
    timer = window.setInterval(readIfVisible, POLL_MS);
  }
  readers.add(onChange);
  if (!reading) readCount();
  return () => {
    readers.delete(onChange);
    if (readers.size === 0) {
      window.removeEventListener(WEBSUB_CHANGED, readCount);
      document.removeEventListener('visibilitychange', readIfVisible);
      window.clearInterval(timer);
    }
  };
}

const watchNothing = () => () => {};

/** Submissions still in status `new`. Managers only; the API refuses anyone else. */
export function useWebSubNewCount(enabled: boolean): number {
  const n = useSyncExternalStore(enabled ? watchCount : watchNothing, () => count);
  return enabled ? n : 0;
}

export const webSubChanged = () => window.dispatchEvent(new Event(WEBSUB_CHANGED));
