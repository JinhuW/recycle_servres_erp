import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { canonicalPartNumber } from './format';

// Recorded market value for whatever part numbers are on screen, fetched in as
// few round trips as the screen allows and keyed canonically so callers look up
// with the same rule the server matched on.
//
// Debounced because the part-number field fires on every keystroke, and
// sequence-guarded so a slow earlier response can't overwrite a newer one.
// (Not AbortController: api.ts single-flights token refresh, and threading a
// signal through it would buy nothing here — a superseded response is simply
// ignored.)
//
// One hook, four consumers (desktop submit, desktop edit order, desktop
// inventory edit, the phone form) so there is a single lookup semantic: a
// `?q=<pn>` substring search narrowed by a client-side match returns the wrong
// row whenever one part number is a substring of another.

export type MarketValue = {
  partNumber: string | null;
  label: string;
  source: string | null;
  demand: 'high' | 'medium' | 'low';
  avgSell: number | null;
  lastPrice: number | null;
  lastPriceAt: string | null;
  lastPriceSource: string | null;
  maxBuy: number | null;
  /** What the team last paid, not a ceiling — the ceiling is `maxBuy`. */
  target: number | null;
  low: number | null;
  high: number | null;
  samples: number;
  updatedAt: string;
  internalSales: { avgPrice: number | null; samples: number };
};

/**
 * A row plus the workspace target margin the same response carried. The server
 * leaves `maxBuy` null for a part it has never priced (auto-tracked at intake),
 * so the buy ceiling has to be derived client-side — and it has to be derived
 * against the workspace's own margin, not a guess. Carrying it on the value is
 * what lets MarketAssist stay a leaf: both shells hand it straight through.
 */
export type ResolvedMarketValue = MarketValue & { targetMargin: number };

const DEBOUNCE_MS = 300;
const MAX_PER_LOOKUP = 100;
/** Mirrors the workspace default in backend lib/settings.ts, until one lands. */
export const TARGET_MARGIN_FALLBACK = 0.30;

/**
 * The distinct canonical keys to ask for, sorted so an unchanged set produces
 * an identical cache key and doesn't refetch. Exported separately from the hook
 * because this half is pure, and the frontend suite has no renderer.
 */
export function lookupKeys(partNumbers: readonly (string | null | undefined)[]): string[] {
  return [...new Set(
    partNumbers.map(p => canonicalPartNumber(p ?? '')).filter(Boolean),
  )].sort();
}

/** Resolve one part number against a fetched map, canonicalising both sides. */
export function resolveMarket(
  values: ReadonlyMap<string, MarketValue>,
  partNumber: string | null | undefined,
  targetMargin: number,
): ResolvedMarketValue | null {
  const canon = canonicalPartNumber(partNumber ?? '');
  const value = canon ? values.get(canon) : undefined;
  return value ? { ...value, targetMargin } : null;
}

/**
 * Everything the screen can be in the middle of, kept apart. A blank panel used
 * to mean "still loading", "never priced" and "the request failed" all at once,
 * and the first and last tell a purchaser standing at a pallet opposite things.
 * `skipped` is a part number past the per-request cap — asked about, never
 * requested.
 */
export type MarketState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'skipped' }
  | { status: 'none' }
  | { status: 'ok'; value: ResolvedMarketValue };

/**
 * Resolving a part number is the call signature — the shape every consumer
 * already uses. The request-level extras hang off it so adding them didn't
 * force four call sites to destructure.
 */
export type MarketLookup = {
  (partNumber: string | null | undefined): ResolvedMarketValue | null;
  /** Loading / failed / over the cap / never priced / priced, for one part. */
  state(partNumber: string | null | undefined): MarketState;
  /** Re-runs the last request. Only a failed one has anything to re-run. */
  retry(): void;
};

export function useMarketLookup(partNumbers: readonly (string | null | undefined)[]): MarketLookup {
  const [values, setValues] = useState<Map<string, MarketValue>>(new Map());
  const [targetMargin, setTargetMargin] = useState(TARGET_MARGIN_FALLBACK);
  // Which key set `values` answers for, so a part number typed after the last
  // response reads as loading rather than as never-priced.
  const [loaded, setLoaded] = useState<{ key: string; ok: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const seqRef = useRef(0);

  // A stable string over the key set, so re-renders that don't change which
  // parts are on screen don't refetch.
  const wanted = lookupKeys(partNumbers);
  const key = wanted.join(' ');
  const asked = wanted.slice(0, MAX_PER_LOOKUP);
  const askedSet = new Set(asked);

  useEffect(() => {
    // Clearing the field supersedes any request already in the air, so it takes
    // a sequence number too — otherwise the guard below still accepts it and
    // the values it was cleared of come back.
    if (!wanted.length) { seqRef.current++; setValues(new Map()); setLoaded(null); return; }
    const timer = setTimeout(() => {
      const seq = ++seqRef.current;
      api.post<{ targetMargin?: number; items: Record<string, MarketValue> }>(
        '/api/market/lookup',
        { partNumbers: asked },
      )
        .then(r => {
          if (seq !== seqRef.current) return;
          setValues(new Map(Object.entries(r.items)));
          if (typeof r.targetMargin === 'number') setTargetMargin(r.targetMargin);
          setLoaded({ key, ok: true });
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setLoaded({ key, ok: false });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  // `key` is the real dependency; `wanted` and `asked` are derived from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const lookup = ((partNumber: string | null | undefined) =>
    resolveMarket(values, partNumber, targetMargin)) as MarketLookup;

  lookup.state = (partNumber) => {
    const canon = canonicalPartNumber(partNumber ?? '');
    if (!canon) return { status: 'none' };
    if (!askedSet.has(canon)) return { status: 'skipped' };
    if (loaded?.key !== key) return { status: 'loading' };
    if (!loaded.ok) return { status: 'error' };
    const value = resolveMarket(values, canon, targetMargin);
    return value ? { status: 'ok', value } : { status: 'none' };
  };
  // Dropping what failed first, so the panel shows the retry running instead of
  // sitting on the error until the next response lands.
  lookup.retry = () => { setLoaded(null); setAttempt(n => n + 1); };

  return lookup;
}
