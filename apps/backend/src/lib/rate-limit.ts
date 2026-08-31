// In-memory sliding-window rate limiter, one budget per limiter.
//
// Per-process and reset by a deploy — deliberately. The callers here throttle
// abuse of an expensive or noisy endpoint, not anything that needs to survive a
// restart; the durable variants (login attempts, DCR) count rows in Postgres
// instead because their limits are a security boundary.

/**
 * Returns a checker: call it with the key you're limiting (a user id) and it
 * records the hit, returning `null` when allowed or the seconds to wait when
 * the window is full — the value to put in `Retry-After`.
 *
 * Each limiter owns its Map, so budgets never bleed between call sites.
 */
export function createRateLimiter(
  windowMs: number,
  max: number,
): (key: string) => number | null {
  const hits = new Map<string, number[]>();

  return (key: string): number | null => {
    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (hits.get(key) ?? []).filter(t => t > cutoff);
    if (recent.length >= max) return Math.ceil((recent[0]! - cutoff) / 1000);
    recent.push(now);
    hits.set(key, recent);
    return null;
  };
}
