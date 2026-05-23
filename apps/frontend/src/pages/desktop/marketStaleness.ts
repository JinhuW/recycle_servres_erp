export const STALE_DAYS = 5;

export function staleness(
  lastPriceAt: string | null,
  now: number = Date.now(),
): { days: number | null; isStale: boolean } {
  if (!lastPriceAt) return { days: null, isStale: true };
  const days = Math.floor((now - +new Date(lastPriceAt)) / 86_400_000);
  return { days, isStale: days > STALE_DAYS };
}
