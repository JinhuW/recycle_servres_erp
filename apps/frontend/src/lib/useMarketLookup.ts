import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { canonicalPartNumber } from './format';

// Recorded market value for whatever part numbers are on screen, fetched in one
// round trip and keyed canonically so callers look up with the same rule the
// server matched on.
//
// Debounced because the part-number field fires on every keystroke, and
// sequence-guarded so a slow earlier response can't overwrite a newer one.
// (Not AbortController: api.ts single-flights token refresh, and threading a
// signal through it would buy nothing here — a superseded response is simply
// ignored.)
//
// One hook, three consumers (desktop submit, desktop edit, the phone form) so
// there is a single lookup semantic — DesktopInventoryEdit's older
// `?q=<pn>`-then-match-client-side approach returns the wrong row whenever one
// part number is a prefix of another.

export type MarketValue = {
  partNumber: string | null;
  label: string;
  avgSell: number | null;
  lastPrice: number | null;
  lastPriceAt: string | null;
  lastPriceSource: string | null;
  maxBuy: number | null;
  low: number | null;
  high: number | null;
  samples: number;
  internalSales: { avgPrice: number | null; samples: number };
};

const DEBOUNCE_MS = 300;
const MAX_PER_LOOKUP = 100;

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
): MarketValue | null {
  const canon = canonicalPartNumber(partNumber ?? '');
  return canon ? values.get(canon) ?? null : null;
}

export function useMarketLookup(partNumbers: readonly (string | null | undefined)[]) {
  const [values, setValues] = useState<Map<string, MarketValue>>(new Map());
  const seqRef = useRef(0);

  // A stable string over the key set, so re-renders that don't change which
  // parts are on screen don't refetch.
  const wanted = lookupKeys(partNumbers);
  const key = wanted.join(' ');

  useEffect(() => {
    if (!wanted.length) { setValues(new Map()); return; }
    const timer = setTimeout(() => {
      const seq = ++seqRef.current;
      api.post<{ items: Record<string, MarketValue> }>(
        '/api/market/lookup',
        { partNumbers: wanted.slice(0, MAX_PER_LOOKUP) },
      )
        .then(r => { if (seq === seqRef.current) setValues(new Map(Object.entries(r.items))); })
        .catch(() => { /* a missing assist is not worth an error banner */ });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  // `key` is the real dependency; `wanted` is derived from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (partNumber: string | null | undefined): MarketValue | null =>
    resolveMarket(values, partNumber);
}
