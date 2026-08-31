// Tracker fleet liveness, judged from heartbeat age. The tracker beats every
// 30 s, so three missed beats (90 s) reads as stale and ten minutes as dead.

export type Liveness = 'live' | 'stale' | 'dead';

export const STALE_AFTER_MS = 90_000;
export const DEAD_AFTER_MS = 600_000;

export function liveness(lastHeartbeatAt: string, now: number = Date.now()): Liveness {
  const age = now - new Date(lastHeartbeatAt).getTime();
  if (age >= DEAD_AFTER_MS) return 'dead';
  if (age >= STALE_AFTER_MS) return 'stale';
  return 'live';
}

