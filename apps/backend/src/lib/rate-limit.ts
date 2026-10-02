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
 * Each limiter owns its Map, so budgets never bleed between call sites. The
 * key count is capped, not the key size: a key the caller chooses (a client
 * id, an email) must be length-checked first, or each one held for the window
 * can be as large as the request body.
 */
export function createRateLimiter(
  windowMs: number,
  max: number,
  maxKeys = MAX_KEYS,
): (key: string) => number | null {
  const hits = new Map<string, number[]>();
  let calls = 0;

  // Keyed by client address on the public forms, so every key a caller can
  // mint is a Map entry: drop the ones whose window has passed, and past the
  // cap drop the oldest-inserted, so the Map cannot grow for the life of the
  // process.  Eviction leaves a tenth of the cap free; trimming to exactly the
  // cap would re-run a full sweep on every call while a flood holds it there.
  const sweep = (cutoff: number) => {
    for (const [k, ts] of hits) if (ts[ts.length - 1]! <= cutoff) hits.delete(k);
    const target = maxKeys - Math.ceil(maxKeys / 10);
    for (const k of hits.keys()) {
      if (hits.size <= target) break;
      hits.delete(k);
    }
  };

  return (key: string): number | null => {
    const now = Date.now();
    const cutoff = now - windowMs;
    if (++calls % SWEEP_EVERY === 0 || hits.size >= maxKeys) sweep(cutoff);
    const recent = (hits.get(key) ?? []).filter(t => t > cutoff);
    if (recent.length >= max) return Math.ceil((recent[0]! - cutoff) / 1000);
    recent.push(now);
    hits.set(key, recent);
    return null;
  };
}

const SWEEP_EVERY = 256;
const MAX_KEYS = 50_000;
