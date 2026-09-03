// Runtime cache for GET /api/warehouses. Mirrors lib/workspace.ts conventions.
//
// Ten components wanted this list, each with its own useEffect and no shared
// state, so a single session was observed asking for it six times in 1.6s. It
// is reference data — the same rows for everyone, changing only when someone
// edits a warehouse in Settings — so it belongs here rather than at each call
// site.
//
// Deliberately not solved with an HTTP cache header: /api/warehouses is the one
// reference list edited and re-read inside a single user action, and a 60s
// browser cache made a saved shipping address look like it had never persisted.
// That exclusion stays in the backend; invalidation here is explicit instead,
// via resetWarehouses() on the write paths in WarehousesPanel.

import { api } from './api';
import type { Warehouse } from './types';

let cached: Warehouse[] | null = null;
let inflight: Promise<Warehouse[]> | null = null;

/**
 * The warehouse list, fetched once per session. Concurrent callers during the
 * first fetch share it rather than each issuing their own.
 */
export function loadWarehouses(): Promise<Warehouse[]> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await api.get<{ items: Warehouse[] }>('/api/warehouses');
      cached = data.items;
      return cached;
    } finally {
      // Cleared either way: a failed load must stay retry-able, exactly as
      // loadLookups() does.
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Drop the cache so the next loadWarehouses() re-fetches. Called on logout, so
 * a subsequent login as a different user doesn't read the previous session's
 * list, and after any write in WarehousesPanel — archiving a warehouse removes
 * it from this list entirely, so a stale copy would keep showing it.
 */
export function resetWarehouses(): void {
  cached = null;
  inflight = null;
}
