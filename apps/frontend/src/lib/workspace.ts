// Runtime cache for workspace_settings (the key/value config behind
// /api/workspace). Loaded once at boot alongside lookups so business-rule
// thresholds that used to be hardcoded in the SPA (low-health %, etc.) read
// from a single DB-backed source. Mirrors lib/lookups.ts conventions.

import { api } from './api';

const settings: Record<string, unknown> = {};
let loaded = false;
let inflight: Promise<void> | null = null;

export function loadWorkspaceSettings(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await api.get<{ settings: Record<string, unknown> }>('/api/workspace');
      for (const k of Object.keys(settings)) delete settings[k];
      Object.assign(settings, data.settings);
      loaded = true;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function resetWorkspaceSettings(): void {
  loaded = false;
  inflight = null;
  for (const k of Object.keys(settings)) delete settings[k];
}

/** Numeric workspace setting with a fallback used until the value loads. */
export function wsNumber(key: string, fallback: number): number {
  const v = settings[key];
  return typeof v === 'number' ? v : fallback;
}
