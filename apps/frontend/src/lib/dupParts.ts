// Pure helpers for part-number duplicate detection on the submit / edit /
// vendor-bid pages. Shared across the desktop, mobile, and vendor shells so
// no shell chunk has to pull in another to get the rule.

// Returns the 1-based line number of the first existing line whose part
// number matches `partNumber` (case- and whitespace-insensitive), or null
// when there is no match. Used by the scan flows to alert the user as soon
// as a re-shot module is detected, instead of waiting for the passive
// per-line drawer banner.
export function findDuplicateLine(
  lines: ReadonlyArray<{ partNumber?: string | null }>,
  partNumber: string | undefined | null,
): number | null {
  if (!partNumber) return null;
  const key = partNumber.trim().toLowerCase();
  if (!key) return null;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i].partNumber ?? '').trim().toLowerCase() === key) return i + 1;
  }
  return null;
}
