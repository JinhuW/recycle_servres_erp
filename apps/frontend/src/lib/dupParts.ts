// Pure helpers for part-number duplicate detection on the submit / edit /
// vendor-bid pages. Shared across the desktop, mobile, and vendor shells so
// no shell chunk has to pull in another to get the rule.
import { canonicalPartNumber } from './format';

// Returns the 1-based line number of the first existing line whose part
// number matches `partNumber`, or null when there is no match. Uses the
// same canonical key as inventory grouping (canonicalPartNumber strips
// PN:/SN:/PART prefixes + all whitespace and upper-cases) so a re-shot
// "PN: ABC 123" matches an existing "ABC123" line. Used by the scan flows
// to alert the user as soon as a re-shot module is detected, instead of
// waiting for the passive per-line drawer banner.
export function findDuplicateLine(
  lines: ReadonlyArray<{ partNumber?: string | null }>,
  partNumber: string | undefined | null,
): number | null {
  const key = canonicalPartNumber(partNumber);
  if (!key) return null;
  for (let i = 0; i < lines.length; i++) {
    if (canonicalPartNumber(lines[i].partNumber) === key) return i + 1;
  }
  return null;
}
