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
import { createPrefSaver, type PrefSaver } from './prefSaver';
import { useAuth } from './auth';
import type { SellOrderLineGroupBy } from './sellOrderLineGroups';

// ── Schema ─────────────────────────────────────────────────────────────────

export type PrefMap = {
  'tweaks.density': 'comfortable' | 'compact';
  'tweaks.rolePreview': 'actual' | 'as_purchaser';
  'inventory.cols.manager': string[];
  'inventory.cols.purchaser': string[];
  'analysis.collapsed': string[];
  'orders.cols': string[];
  'market.showStaleOnly': boolean;
  // Category the PO submit form pre-selects for its first line. Every category
  // stays one click away in the add control — this only saves re-picking when
  // someone works through a pallet of one kind.
  'submit.lastCategory': string;
  // Desk scanner: open the live camera in every new line drawer, and which
  // camera (by device label — the Continuity iPhone, usually) to use.
  'scan.deskCamera': boolean;
  'scan.cameraLabel': string;
  // How a sell order's lines are grouped: where they ship from, or which PO
  // they came in on.
  'sellOrders.lineGroup': SellOrderLineGroupBy;
  // The bench labels: Pack mode's per product, printed by itself as each is
  // packed, and Review mode's per PO box, printed by itself on approval. The
  // stock (width × height as it feeds) and the language the Bluetooth printer
  // speaks ('auto' goes by its service) are the one printer's, so both pages
  // share them.
  'pack.labelAuto': boolean;
  'review.labelAuto': boolean;
  'pack.labelSize': '50x25mm' | '4x6' | '4x3' | '2.25x1.25';
  'pack.labelLanguage': 'auto' | 'tspl' | 'zpl' | 'escpos';
  // Desktop sidebar folded to its icon rail at any width (under 900px the
  // rail is forced regardless).
  'sidebar.folded': boolean;
  // The account panel beside a worker's live browser, folded away.
  'fleetWatch.accountHidden': boolean;
  // My leads under Leads ▸ Reddit: a list ranked by urgency, or a board by stage.
  'leads.view': 'list' | 'board';
  // Finished or skipped the purchaser walkthrough; it opens by itself until
  // this is set.
  'onboarding.done': boolean;
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

// ── Context + provider ─────────────────────────────────────────────────────

type Ctx = {
  prefs: PrefBag;
  setPref: <K extends PrefKey>(key: K, value: PrefMap[K]) => void;
};

const PreferencesCtx = createContext<Ctx | null>(null);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const signedOut = !user && !loading;
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
  // Who the next save is for. The saver reads it when a reply lands, so a
  // reply started for one user is dropped once another has signed in.
  const userIdRef = useRef<string | null>(user?.id ?? null);
  userIdRef.current = user?.id ?? null;
  const saverRef = useRef<PrefSaver | null>(null);
  saverRef.current ??= createPrefSaver({
    patch: (batch) => api.patch<{ user: { preferences: PrefBag } }>('/api/me/preferences', batch)
      .then((r) => r.user.preferences ?? {}),
    identity: () => userIdRef.current,
    // The server's bag, with the newer edits on top — those queued behind
    // this save and those still waiting for their own flush: a reply never
    // undoes a newer local choice.
    onServer: (server, queued) => {
      setPrefs(() => {
        const next = { ...server, ...queued, ...pendingRef.current };
        writeCache(next);
        return next;
      });
    },
    onRollback: (keys, rollback) => {
      setPrefs((cur) => {
        const next = { ...cur };
        for (const k of keys) {
          if (rollback.absent.has(k)) delete next[k];
          else if (k in rollback.values) next[k] = rollback.values[k];
        }
        writeCache(next);
        return next;
      });
    },
  });

  // Whenever auth resolves with a user, reconcile against the server blob.
  // On sign-out, drop the lot: a pending timer would otherwise fire a save
  // for a session that is gone, and the cache would show the previous user's
  // settings to the next one at this browser. Not while auth is still
  // asking: every cold load starts with no user, and wiping then threw away
  // the cached bag the first paint is built from.
  useEffect(() => {
    if (!user) {
      if (!signedOut) return;
      if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      pendingRef.current = {};
      rollbackRef.current = {};
      rollbackAbsentRef.current = new Set();
      setPrefs({});
      writeCache({});
      return;
    }
    const server: PrefBag = (user.preferences ?? {}) as PrefBag;
    setPrefs(server);
    writeCache(server);

    // Keyed on identity, not the object: `user.preferences` is only refreshed at
    // sign-in (flush() updates local prefs, never AuthProvider), so re-running
    // this for a same-user object churn — setLang does `setUser({...user})` —
    // would reset every preference saved since login back to that snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, signedOut]);

  const flush = useCallback(async () => {
    timerRef.current = null;
    const batch = pendingRef.current;
    pendingRef.current = {};
    // Snapshot and reset the rollback records alongside the batch so a
    // concurrent edit starts a fresh cycle.
    const rollback = { values: rollbackRef.current, absent: rollbackAbsentRef.current };
    rollbackRef.current = {};
    rollbackAbsentRef.current = new Set();
    if (Object.keys(batch).length === 0) return;
    try {
      await saverRef.current!.save(batch, rollback);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('Preference save failed; rolled back.', err);
    }
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
