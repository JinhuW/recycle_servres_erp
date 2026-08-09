// How old a recorded price may get before the screen stops standing behind it.
// Lives in lib/ rather than the desktop pages because MarketAssist shows the
// same age on the phone. Mirrored server-side in routes/market.ts (?staleOnly).
export const STALE_DAYS = 5;

export function staleness(
  lastPriceAt: string | null,
  now: number = Date.now(),
): { days: number | null; isStale: boolean } {
  if (!lastPriceAt) return { days: null, isStale: true };
  const days = Math.floor((now - +new Date(lastPriceAt)) / 86_400_000);
  return { days, isStale: days > STALE_DAYS };
}
