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

export function useMarketLookup(partNumbers: readonly (string | null | undefined)[]) {
  const [values, setValues] = useState<Map<string, MarketValue>>(new Map());
  const [targetMargin, setTargetMargin] = useState(TARGET_MARGIN_FALLBACK);
  const seqRef = useRef(0);

  // A stable string over the key set, so re-renders that don't change which
  // parts are on screen don't refetch.
  const wanted = lookupKeys(partNumbers);
  const key = wanted.join(' ');

  useEffect(() => {
    // Clearing the field supersedes any request already in the air, so it takes
    // a sequence number too — otherwise the guard below still accepts it and
    // the values it was cleared of come back.
    if (!wanted.length) { seqRef.current++; setValues(new Map()); return; }
    const timer = setTimeout(() => {
      const seq = ++seqRef.current;
      api.post<{ targetMargin?: number; items: Record<string, MarketValue> }>(
        '/api/market/lookup',
        { partNumbers: wanted.slice(0, MAX_PER_LOOKUP) },
      )
        .then(r => {
          if (seq !== seqRef.current) return;
          setValues(new Map(Object.entries(r.items)));
          if (typeof r.targetMargin === 'number') setTargetMargin(r.targetMargin);
        })
        .catch(() => { /* a missing assist is not worth an error banner */ });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  // `key` is the real dependency; `wanted` is derived from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (partNumber: string | null | undefined): ResolvedMarketValue | null =>
    resolveMarket(values, partNumber, targetMargin);
}
