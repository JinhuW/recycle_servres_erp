import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { canonicalPartNumber } from './format';

// Existing part numbers matching what is being typed, for the Part # field on
// the capture screens.
//
// Same shape as useMarketLookup — 300ms debounce because the field fires on
// every keystroke, and a sequence guard so a slow earlier response can't
// overwrite a newer one. The two hooks run side by side on the same field:
// this one offers the spellings already on record, useMarketLookup prices the
// one that ends up in the box.

export type PartSuggestion = {
  partNumber: string;
  label: string | null;
  category: string | null;
};

const DEBOUNCE_MS = 300;
/** Below this many canonical characters every part in the book matches. */
export const SUGGEST_MIN = 2;

/**
 * The query the server would be asked for this input, or '' when the field is
 * too short to ask about. Pure, and the half worth testing — the frontend suite
 * has no renderer.
 */
export function suggestQuery(raw: string | null | undefined): string {
  const canon = canonicalPartNumber(raw ?? '');
  return canon.length >= SUGGEST_MIN ? canon : '';
}

export type PartSuggest = {
  /** Part numbers to offer, server-ranked: prefix matches first. */
  options: string[];
  /** Part number → "label · category", for the secondary text on each row. */
  meta: Map<string, string>;
  loading: boolean;
};

export function usePartSuggest(value: string | null | undefined): PartSuggest {
  const [items, setItems] = useState<PartSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);

  const q = suggestQuery(value);

  useEffect(() => {
    // Clearing the field supersedes a request already in the air, so it takes a
    // sequence number too — otherwise the guard below still accepts it and the
    // suggestions it was cleared of come back.
    if (!q) { seqRef.current++; setItems([]); setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      const seq = ++seqRef.current;
      api.get<{ items: PartSuggestion[] }>(`/api/market/parts?q=${encodeURIComponent(q)}`)
        .then(r => {
          if (seq !== seqRef.current) return;
          setItems(r.items);
          setLoading(false);
        })
        .catch(() => {
          // A failed suggest is not worth a message: the field still accepts
          // whatever is typed, which is the whole contract.
          if (seq !== seqRef.current) return;
          setItems([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const meta = new Map<string, string>();
  for (const it of items) {
    const text = [it.label, it.category].filter(Boolean).join(' · ');
    if (text) meta.set(it.partNumber, text);
  }

  return { options: items.map(i => i.partNumber), meta, loading };
}
