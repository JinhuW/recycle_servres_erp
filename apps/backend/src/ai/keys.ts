// Provider API keys: pasted on Settings ▸ AI models and stored sealed in
// ai_provider_keys, or else the provider's env var. A saved key is pushed to
// the Reddit tracker too, so every key is managed in one place.

import { hkdfSync } from 'node:crypto';
import { AI_PROVIDERS, type AiProviderId } from '@recycle-erp/shared';
import type { Env } from '../types';
import { getDb } from '../db';
import { seal, unseal } from '../lib/sealed';
import { log } from '../lib/log';

export type AiKeys = Partial<Record<AiProviderId, string>>;

export const KEY_ENV: Record<AiProviderId, 'OPENROUTER_API_KEY' | 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'> = {
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const TTL_MS = 30_000;
const TRACKER_TIMEOUT_MS = 10_000;
const klog = log.child({ module: 'ai-keys' });

/**
 * The sealing key: derived from FB_POOL_KEY under its own label, so it is not
 * the pool's key and needs no variable of its own. Null when production has
 * no FB_POOL_KEY; outside production it comes from JWT_SECRET, as poolKey does.
 */
export function aiKeysKey(env: Env): Buffer | null {
  const raw = env.FB_POOL_KEY?.trim();
  if (raw) return Buffer.from(hkdfSync('sha256', Buffer.from(raw, 'hex'), '', 'ai-keys', 32));
  if (env.NODE_ENV === 'production' || !env.JWT_SECRET) return null;
  return Buffer.from(hkdfSync('sha256', env.JWT_SECRET, '', 'ai-keys', 32));
}

function fromEnv(env: Env): AiKeys {
  const out: AiKeys = {};
  for (const p of AI_PROVIDERS) {
    const v = env[KEY_ENV[p]]?.trim();
    if (v) out[p] = v;
  }
  return out;
}

let cache: { stored: AiKeys; expiresAt: number } | null = null;

export function invalidateAiKeys(): void {
  cache = null;
}

async function storedKeys(env: Env): Promise<AiKeys> {
  if (cache && Date.now() < cache.expiresAt) return cache.stored;
  if (!env.DATABASE_URL) return {};
  const key = aiKeysKey(env);
  if (!key) return {};
  try {
    const rows = await getDb(env)<{ provider: AiProviderId; sealed: string }[]>`
      SELECT provider, sealed FROM ai_provider_keys`;
    const stored: AiKeys = {};
    for (const r of rows) {
      try {
        stored[r.provider] = unseal(r.sealed, key);
      } catch {
        // A rotated FB_POOL_KEY leaves the row unreadable: say which, never what.
        klog.warn('stored AI key could not be unsealed; using env', { provider: r.provider });
      }
    }
    cache = { stored, expiresAt: Date.now() + TTL_MS };
    return stored;
  } catch (e) {
    klog.warn('could not read ai_provider_keys; using env', e);
    return cache?.stored ?? {};
  }
}

/** Every provider's key: a saved one wins over the env var. */
export async function aiKeys(env: Env): Promise<AiKeys> {
  return { ...fromEnv(env), ...(await storedKeys(env)) };
}

/** Synchronous best guess for /api/health: the last read of saved keys plus env. */
export function aiKeysSnapshot(env: Env): AiKeys {
  return { ...fromEnv(env), ...(cache?.stored ?? {}) };
}

export function sealKey(env: Env, plain: string): string {
  const key = aiKeysKey(env);
  if (!key) throw new Error('FB_POOL_KEY is not set');
  return seal(plain, key);
}

export type TrackerSync = { trackerSynced: boolean; trackerError?: string };

/**
 * Writes (or with null, removes) `provider`'s key on the Reddit tracker. Never
 * throws: the ERP's own save stands either way, and the page offers a retry.
 */
export async function pushKeyToTracker(env: Env, provider: AiProviderId, plain: string | null): Promise<TrackerSync> {
  const base = env.TRACKER_API_URL?.replace(/\/+$/, '');
  const token = env.TRACKER_API_TOKEN;
  if (!base || !token) return { trackerSynced: false, trackerError: 'Tracker is not configured' };
  try {
    const res = await fetch(`${base}/api/llm-keys/${provider}`, {
      method: plain === null ? 'DELETE' : 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(plain === null ? {} : { body: JSON.stringify({ key: plain }) }),
      signal: AbortSignal.timeout(TRACKER_TIMEOUT_MS),
    });
    if (res.ok) return { trackerSynced: true };
    klog.warn('tracker refused an AI key push', { provider, upstreamStatus: res.status });
    return { trackerSynced: false, trackerError: `Tracker answered ${res.status}` };
  } catch {
    klog.warn('tracker unreachable for an AI key push', { provider });
    return { trackerSynced: false, trackerError: 'Tracker API is unreachable' };
  }
}
