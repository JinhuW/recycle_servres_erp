import { useEffect, useState } from 'react';
import { api } from './api';

type Health = { status: string; version: string; commit: string };

// The deployed version isn't baked into the bundle — it's stamped into the
// backend image at release time and surfaced at /api/health. Reading it from
// there means the footer reflects what is actually running, and the single
// source of truth (root package.json -> image -> health) can't drift from a
// hand-edited frontend constant. Unauthenticated GET, so it works on every
// shell regardless of login state.
let cache: { version: string; commit: string } | null = null;

export function useAppVersion(): { version: string; commit: string } | null {
  const [v, setV] = useState(cache);
  useEffect(() => {
    if (cache) return;
    let alive = true;
    api
      .get<Health>('/api/health')
      .then((h) => {
        cache = { version: h.version, commit: h.commit };
        if (alive) setV(cache);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return v;
}
