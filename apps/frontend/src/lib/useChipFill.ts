import { useEffect, useRef } from 'react';
import { api } from './api';
import { canonicalPartNumber } from './format';

// Fills a RAM line's blank chip # from the part number → chip map the backend
// learns from past PO lines (POST /api/market/chips), so a chip marking is
// typed once per part number rather than once per line.
//
// Same debounce + sequence guard as usePartSuggest. Three rules keep it from
// writing where nobody asked it to:
//   - the part # a line OPENED with never triggers a fill: opening an untouched
//     submitted line must not dirty it, and chip_number is a material field
//     that would send a purchaser's PO back to Draft on save;
//   - a chip the user typed is never replaced — only the hook's own fill is, so
//     a pause mid-typing that matched a shorter part # corrects itself;
//   - a part # is asked about once, so clearing the filled chip keeps it clear.

const DEBOUNCE_MS = 300;
/** Shorter than this, a half-typed part # can exactly match an unrelated one. */
export const CHIP_FILL_MIN = 6;

export type ChipFillLine = {
  category?: string | null;
  partNumber?: string | null;
  chipNumber?: string | null;
};

export type ChipFillMemory = {
  /** Canonical part # the line had when the form opened. */
  mountPart: string;
  /** Canonical part # last looked up, answered or not. */
  answeredFor: string | null;
  /** The chip # this hook wrote, while it is still the field's value. */
  autoFilled: string | null;
};

/**
 * The canonical part # to ask the map about, or '' when the line shouldn't be
 * filled. Pure — the half worth testing, since the frontend suite has no renderer.
 */
export function chipFillQuery(line: ChipFillLine, mem: ChipFillMemory, enabled = true): string {
  if (!enabled || line.category !== 'RAM') return '';
  const canon = canonicalPartNumber(line.partNumber ?? '');
  if (canon.length < CHIP_FILL_MIN) return '';
  if (canon === mem.mountPart || canon === mem.answeredFor) return '';
  const chip = (line.chipNumber ?? '').trim();
  if (chip && chip !== mem.autoFilled) return '';
  return canon;
}

/** Batch form, for callers that add many lines at once. Keyed by the asked spelling. */
export async function lookupChips(partNumbers: string[]): Promise<Record<string, string>> {
  if (partNumbers.length === 0) return {};
  const r = await api.post<{ items: Record<string, string> }>('/api/market/chips', { partNumbers });
  return r.items;
}

export function useChipFill(
  line: ChipFillLine,
  { enabled, onFill, savedPartNumber = line.partNumber }: {
    enabled: boolean;
    onFill: (chip: string) => void;
    /** The part # already on record for this line; defaults to the one it opened with. */
    savedPartNumber?: string | null;
  },
): void {
  const mem = useRef<ChipFillMemory>({
    mountPart: canonicalPartNumber(savedPartNumber ?? ''),
    answeredFor: null,
    autoFilled: null,
  });
  // The reply lands a debounce and a round trip after the effect ran; the
  // desktop parent only merges patches, so "is the chip still blank?" has to be
  // asked of the line as it is then, not as the effect saw it.
  const lineRef = useRef(line);
  lineRef.current = line;
  const onFillRef = useRef(onFill);
  onFillRef.current = onFill;
  const seqRef = useRef(0);

  const m = mem.current;
  if (m.autoFilled !== null && (line.chipNumber ?? '').trim() !== m.autoFilled) {
    m.autoFilled = null;
  }
  const q = chipFillQuery(line, m, enabled);

  useEffect(() => {
    if (!q) { seqRef.current++; return; }
    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      lookupChips([q])
        .then(items => {
          if (seq !== seqRef.current) return;
          if (chipFillQuery(lineRef.current, mem.current, enabled) !== q) return;
          mem.current.answeredFor = q;
          const chip = items[q];
          if (chip) {
            mem.current.autoFilled = chip;
            onFillRef.current(chip);
          } else if (mem.current.autoFilled !== null) {
            // The earlier fill was for a part # this one no longer is.
            mem.current.autoFilled = null;
            onFillRef.current('');
          }
        })
        // A failed lookup costs nothing but the convenience: the field is
        // still there to type into.
        .catch(() => {});
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, enabled]);
}
