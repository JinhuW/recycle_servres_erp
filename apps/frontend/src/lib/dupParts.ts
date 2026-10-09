// Pure helpers for part-number duplicate detection on the submit / edit
// pages. Kept out of any shell module so no shell chunk has to pull in another
// to get the rule.
import { canonicalPartNumber } from './format';

// Returns the first existing line whose part number matches `partNumber`, or
// null when there is no match — the caller names it (lineRef). Uses the
// same canonical key as inventory grouping (canonicalPartNumber strips
// PN:/SN:/PART prefixes + all whitespace and upper-cases) so a re-shot
// "PN: ABC 123" matches an existing "ABC123" line. Used by the scan flows
// to alert the user as soon as a re-shot module is detected, instead of
// waiting for the passive per-line drawer banner.
export function findDuplicateLine<L extends { partNumber?: string | null }>(
  lines: ReadonlyArray<L>,
  partNumber: string | undefined | null,
): L | null {
  const key = canonicalPartNumber(partNumber);
  if (!key) return null;
  return lines.find(l => canonicalPartNumber(l.partNumber) === key) ?? null;
}
