// Provider API keys: pasted on Settings ▸ AI models and stored sealed in
// ai_provider_keys, the only place calls read them from. A saved key is
// pushed to the Reddit tracker too, so every key is managed in one place.
// The old env vars are read once, at boot, by importEnvAiSettings.

import { hkdfSync } from 'node:crypto';
import {
  AI_PROVIDERS, isModelRef, parseModelRef, type AiModelsSetting, type AiProviderId,
} from '@recycle-erp/shared';
import type { Env } from '../types';
import { getDb, type SqlLike } from '../db';
import { seal, unseal } from '../lib/sealed';
import { getWorkspaceSetting } from '../lib/settings';
import { log } from '../lib/log';
import { invalidateAiModelsSetting } from './llm';

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

let cache: { stored: AiKeys; expiresAt: number } | null = null;
// Bumped on every save or removal, so a read that started before one can't
// put the old keys back into the cache after it.
let generation = 0;

export function invalidateAiKeys(): void {
  generation++;
  cache = null;
}

async function storedKeys(env: Env, { quiet = false } = {}): Promise<AiKeys> {
  if (cache && Date.now() < cache.expiresAt) return cache.stored;
  if (!env.DATABASE_URL) return {};
  const key = aiKeysKey(env);
  if (!key) return {};
  const gen = generation;
  try {
    const rows = await getDb(env)<{ provider: AiProviderId; sealed: string }[]>`
      SELECT provider, sealed FROM ai_provider_keys`;
    const stored: AiKeys = {};
    for (const r of rows) {
      try {
        stored[r.provider] = unseal(r.sealed, key);
      } catch {
        // A rotated FB_POOL_KEY leaves the row unreadable: say which, never what.
        if (!quiet) klog.warn('stored AI key could not be unsealed', { provider: r.provider });
      }
    }
    if (gen === generation) cache = { stored, expiresAt: Date.now() + TTL_MS };
    return stored;
  } catch (e) {
    if (!quiet) klog.warn('could not read ai_provider_keys', e);
    return cache?.stored ?? {};
  }
}

/** Every provider's saved key. */
export async function aiKeys(env: Env): Promise<AiKeys> {
  return storedKeys(env);
}

/**
 * For /api/health: the last read of saved keys, without logging. Reads the
 * table only while nothing has been read yet (just after a restart), when
 * the snapshot would report no saved key at all.
 */
export async function aiKeysForHealth(env: Env): Promise<AiKeys> {
  if (cache) return cache.stored;
  return storedKeys(env, { quiet: true });
}

/** Whether calls to `provider` have a saved key. */
export async function providerHasKey(env: Env, provider: AiProviderId): Promise<boolean> {
  return !!(await aiKeys(env))[provider];
}

/** Whether a call to model ref `ref` has a key for its provider. */
export async function modelHasKey(env: Env, ref: string): Promise<boolean> {
  return providerHasKey(env, parseModelRef(ref).provider);
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

// Matched on the sealed value: a save that landed meanwhile owns the flag.
export async function recordSync(sql: SqlLike, provider: AiProviderId, sealed: string, synced: boolean): Promise<void> {
  await sql`
    UPDATE ai_provider_keys SET tracker_synced = ${synced}
    WHERE provider = ${provider} AND sealed = ${sealed}`;
}

/** The `ai_env_imported` workspace setting: what the boot import took from env. */
export type AiEnvImported = { providers: AiProviderId[]; model: boolean; at: string };

/**
 * Moves the old env settings into the database, once per database: each
 * provider's key into ai_provider_keys (and on to the tracker), and AI_MODEL
 * (or OPENROUTER_OCR_MODEL) into an empty ai_models.default. The marker it
 * writes stops every later boot, so a key removed on the page doesn't come
 * back from a variable nobody deleted. Never throws: boot goes on without it.
 */
export async function importEnvAiSettings(env: Env): Promise<AiEnvImported | null> {
  try {
    return await runEnvImport(env);
  } catch (e) {
    klog.error('importing AI settings from env failed; will retry on the next boot', e);
    return null;
  }
}

async function runEnvImport(env: Env): Promise<AiEnvImported | null> {
  if (!env.DATABASE_URL) return null;
  const envKeys: AiKeys = {};
  for (const p of AI_PROVIDERS) {
    const v = env[KEY_ENV[p]]?.trim();
    if (v) envKeys[p] = v;
  }
  const envModel = env.AI_MODEL?.trim() || env.OPENROUTER_OCR_MODEL?.trim() || null;
  const sealKeyBuf = aiKeysKey(env);
  if (!sealKeyBuf && Object.keys(envKeys).length > 0) {
    // No marker either, so the import runs once FB_POOL_KEY is set.
    klog.error('AI keys in env were not imported: FB_POOL_KEY is not set, so they cannot be stored');
    return null;
  }

  const sql = getDb(env);
  const imported: { provider: AiProviderId; plain: string; sealed: string }[] = [];
  const done = await sql.begin(async (tx) => {
    // Two instances booting together must not both import.
    await tx`SELECT pg_advisory_xact_lock(hashtext('ai_env_imported'))`;
    const [marker] = await tx`SELECT 1 FROM workspace_settings WHERE key = 'ai_env_imported'`;
    if (marker) return null;
    const [rows, removals] = await Promise.all([
      tx<{ provider: AiProviderId }[]>`SELECT provider FROM ai_provider_keys`,
      tx<{ provider: AiProviderId }[]>`SELECT provider FROM ai_provider_key_removals`,
    ]);
    // A removal still pending on the tracker counts as a decision too.
    const taken = new Set([...rows, ...removals].map((r) => r.provider));
    const keyed = new Set(rows.map((r) => r.provider));
    for (const p of AI_PROVIDERS) {
      const plain = envKeys[p];
      if (!plain || taken.has(p)) continue;
      const sealed = seal(plain, sealKeyBuf!);
      await tx`
        INSERT INTO ai_provider_keys (provider, sealed, last4, updated_by, tracker_synced)
        VALUES (${p}, ${sealed}, ${plain.slice(-4)}, NULL, FALSE)`;
      imported.push({ provider: p, plain, sealed });
      keyed.add(p);
    }

    // Only a model whose provider has a key: before, an env model without
    // one gave way to a keyed provider's default, and it still does.
    let model = false;
    const models = await getWorkspaceSetting<AiModelsSetting>(tx, 'ai_models', { default: null });
    if (!models.default && envModel && isModelRef(envModel) && keyed.has(parseModelRef(envModel).provider)) {
      await tx`
        INSERT INTO workspace_settings (key, value, updated_at)
        VALUES ('ai_models', ${tx.json({ ...models, default: envModel } as never)}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
      model = true;
    }

    const result: AiEnvImported = {
      providers: imported.map((i) => i.provider), model, at: new Date().toISOString(),
    };
    await tx`
      INSERT INTO workspace_settings (key, value, updated_at)
      VALUES ('ai_env_imported', ${tx.json(result as never)}, NOW())`;
    return result;
  });
  if (!done) return null;

  invalidateAiKeys();
  if (done.model) invalidateAiModelsSetting();
  for (const { provider, plain, sealed } of imported) {
    const sync = await pushKeyToTracker(env, provider, plain);
    await recordSync(sql, provider, sealed, sync.trackerSynced);
  }
  klog.info('AI settings imported from env; the env vars are no longer read', {
    providers: done.providers, model: done.model,
  });
  return done;
}
