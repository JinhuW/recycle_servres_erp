import { timingSafeEqual } from 'node:crypto';

/**
 * Compares a caller-presented credential against the configured one in
 * constant time. An unset `expected` never matches, so a missing config value
 * fails closed instead of accepting an empty header.
 */
export function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!expected || given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would leak length by
  // status code — compare lengths first and still run the constant-time check.
  return a.length === b.length && timingSafeEqual(a, b);
}
