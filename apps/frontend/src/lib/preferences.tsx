// Server-backed user preferences (per-user, synced across devices).
//
// Server is the source of truth (users.preferences JSONB). On mount we seed
// from a localStorage cache so the first paint is instant, then reconcile
// with the server-issued user.preferences as soon as AuthProvider resolves.
//
// Adding a new preference is a one-line change: add a key to `PrefMap`, the
// server allowlist in apps/backend/src/preferences.ts, and consumers call
// `usePreference('your.key', fallback)`.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import { useAuth } from './auth';

// ── Schema ─────────────────────────────────────────────────────────────────

export type PrefMap = {
  'language': 'en' | 'zh';
  'tweaks.density': 'comfortable' | 'compact';
  'tweaks.rolePreview': 'actual' | 'as_purchaser';
  'inventory.cols.manager': string[];
  'inventory.cols.purchaser': string[];
  'orders.cols': string[];
};

export type PrefKey = keyof PrefMap;

const CACHE_KEY = 'rs.prefs.v1';
const PATCH_DEBOUNCE_MS = 400;

// ── Cache helpers ──────────────────────────────────────────────────────────

type PrefBag = Record<string, unknown>;

function readCache(): PrefBag {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PrefBag)
      : {};
  } catch {
    return {};
  }
}

function writeCache(bag: PrefBag): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify(bag)); }
  catch { /* quota errors are fine; cache is best-effort */ }
}

// ── Legacy localStorage migration (one-time, idempotent) ────────────────────

// Pull values out of the old scattered localStorage keys and push them to the
// server the first time PreferencesProvider runs against a user whose server
// blob is empty for the corresponding key. Runs once per browser per key.

const LEGACY_KEYS: Array<{
  legacy: string;
  parse: (raw: string) => Partial<PrefBag> | null;
}> = [
  {
    legacy: 'rs.orders.cols.v1',
    parse: (raw) => {
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? { 'orders.cols': v } : null;
      } catch { return null; }
    },
  },
  {
    legacy: 'rs.inventory.cols.v1',
    parse: (raw) => {
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? { 'inventory.cols.manager': v } : null;
      } catch { return null; }
    },
  },
  {
    legacy: 'rs.inventory.cols.purchaser.v1',
    parse: (raw) => {
      try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? { 'inventory.cols.purchaser': v } : null;
      } catch { return null; }
    },
  },
  {
    legacy: 'rs.tweaks.v1',
    parse: (raw) => {
      try {
        const v = JSON.parse(raw) as { density?: string; rolePreview?: string };
        const out: Partial<PrefBag> = {};
        if (v?.density === 'compact' || v?.density === 'comfortable') {
          out['tweaks.density'] = v.density;
        }
        if (v?.rolePreview === 'as_purchaser' || v?.rolePreview === 'actual') {
          out['tweaks.rolePreview'] = v.rolePreview;
        }
        return Object.keys(out).length > 0 ? out : null;
      } catch { return null; }
    },
  },
];

function collectLegacyMigration(server: PrefBag): {
  patch: PrefBag;
  legacyKeysToClear: string[];
} {
  if (typeof window === 'undefined') return { patch: {}, legacyKeysToClear: [] };
  const patch: PrefBag = {};
  const legacyKeysToClear: string[] = [];
  for (const { legacy, parse } of LEGACY_KEYS) {
    const raw = window.localStorage.getItem(legacy);
    if (!raw) continue;
    const parsed = parse(raw);
    if (!parsed) {
      // Garbage in the legacy slot — just clear it.
      legacyKeysToClear.push(legacy);
      continue;
    }
    let contributedSomething = false;
    for (const [k, v] of Object.entries(parsed)) {
      if (server[k] === undefined && patch[k] === undefined) {
        patch[k] = v;
        contributedSomething = true;
      }
    }
    // Clear regardless — the server (or another legacy key) already has this
    // value; the localStorage cache will be repopulated from the new bag.
    legacyKeysToClear.push(legacy);
    void contributedSomething;
  }
  return { patch, legacyKeysToClear };
}

// ── Context + provider ─────────────────────────────────────────────────────

type Ctx = {
  prefs: PrefBag;
  setPref: <K extends PrefKey>(key: K, value: PrefMap[K]) => void;
};

const PreferencesCtx = createContext<Ctx | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState<PrefBag>(() => readCache());

  // Pending changes waiting to flush.
  const pendingRef = useRef<PrefBag>({});
  // Per-key snapshot of the value *before* the first optimistic edit in the
  // current pending cycle. Used to roll back accurately on save failure —
  // capturing at flush time would record an already-optimistic value when the
  // debounce coalesces multiple edits.
  const rollbackRef = useRef<PrefBag>({});
  const rollbackAbsentRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<number | null>(null);
  const inflightRef = useRef<Promise<unknown> | null>(null);
  const legacyMigratedRef = useRef(false);

  // Whenever auth resolves with a user, reconcile against the server blob and
  // run the one-time legacy migration.
  useEffect(() => {
    if (!user) {
      legacyMigratedRef.current = false;
      return;
    }
    const server: PrefBag = (user.preferences ?? {}) as PrefBag;
    setPrefs(server);
    writeCache(server);

    if (legacyMigratedRef.current) return;
    legacyMigratedRef.current = true;

    const { patch, legacyKeysToClear } = collectLegacyMigration(server);
    if (Object.keys(patch).length > 0) {
      api.patch<{ user: { preferences: PrefBag } }>('/api/me/preferences', patch)
        .then((r) => {
          const merged = r.user.preferences ?? {};
          setPrefs(merged);
          writeCache(merged);
          for (const k of legacyKeysToClear) window.localStorage.removeItem(k);
        })
        .catch(() => { /* leave legacy keys in place to retry next session */ });
    } else {
      for (const k of legacyKeysToClear) window.localStorage.removeItem(k);
    }
  }, [user]);

  const flush = useCallback(async () => {
    timerRef.current = null;
    const batch = pendingRef.current;
    pendingRef.current = {};
    // Snapshot and reset the rollback records alongside the batch so a
    // concurrent edit starts a fresh cycle.
    const rollback = rollbackRef.current;
    const rollbackAbsent = rollbackAbsentRef.current;
    rollbackRef.current = {};
    rollbackAbsentRef.current = new Set();
    if (Object.keys(batch).length === 0) return;
    const send = api.patch<{ user: { preferences: PrefBag } }>('/api/me/preferences', batch)
      .then((r) => {
        const merged = r.user.preferences ?? {};
        setPrefs(merged);
        writeCache(merged);
      })
      .catch((err) => {
        // Roll back the touched keys to their true pre-edit values.
        setPrefs((cur) => {
          const next = { ...cur };
          for (const k of Object.keys(batch)) {
            if (rollbackAbsent.has(k)) delete next[k];
            else if (k in rollback) next[k] = rollback[k];
          }
          writeCache(next);
          return next;
        });
        // eslint-disable-next-line no-console
        console.warn('Preference save failed; rolled back.', err);
      })
      .finally(() => { inflightRef.current = null; });
    inflightRef.current = send;
    await send;
  }, []);

  const setPref = useCallback(<K extends PrefKey>(key: K, value: PrefMap[K]) => {
    setPrefs((cur) => {
      // Record the pre-edit value once per pending cycle so rollback restores
      // the true original, not an intermediate optimistic value.
      if (!(key in rollbackRef.current) && !rollbackAbsentRef.current.has(key)) {
        if (key in cur) rollbackRef.current[key] = cur[key];
        else rollbackAbsentRef.current.add(key);
      }
      const next = { ...cur, [key]: value };
      writeCache(next);
      return next;
    });
    pendingRef.current = { ...pendingRef.current, [key]: value };
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void flush(); }, PATCH_DEBOUNCE_MS);
  }, [flush]);

  // Flush any pending batch on unmount (best-effort).
  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      void flush();
    }
  }, [flush]);

  const value = useMemo<Ctx>(() => ({ prefs, setPref }), [prefs, setPref]);
  return <PreferencesCtx.Provider value={value}>{children}</PreferencesCtx.Provider>;
}

// ── Hooks ──────────────────────────────────────────────────────────────────

function usePrefsCtx(): Ctx {
  const v = useContext(PreferencesCtx);
  if (!v) throw new Error('usePreference must be used inside <PreferencesProvider>');
  return v;
}

export function usePreference<K extends PrefKey>(
  key: K,
  fallback: PrefMap[K],
): [PrefMap[K], (value: PrefMap[K]) => void] {
  const { prefs, setPref } = usePrefsCtx();
  const raw = prefs[key];
  const value = (raw === undefined ? fallback : (raw as PrefMap[K]));
  const set = useCallback((next: PrefMap[K]) => setPref(key, next), [setPref, key]);
  return [value, set];
}
