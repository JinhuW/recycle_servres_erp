import type { AiProviderId } from '@recycle-erp/shared';
import type { SqlLike } from '../../src/db';
import { invalidateAiKeys, sealKey } from '../../src/ai/keys';
import type { Env } from '../../src/types';
import { getTestDb } from './db';
import { testEnv } from './app';

// Keys are read only from ai_provider_keys, so a test that needs a provider
// to have one saves it the way Settings ▸ AI models does. Sealed under `env`'s
// key: read it back with the same env (testEnv, or one with FB_POOL_KEY).
export async function seedAiKey(sql: SqlLike, env: Env, provider: AiProviderId, key: string): Promise<void> {
  await sql`
    INSERT INTO ai_provider_keys (provider, sealed, last4, tracker_synced)
    VALUES (${provider}, ${sealKey(env, key)}, ${key.slice(-4)}, TRUE)
    ON CONFLICT (provider) DO UPDATE SET sealed = EXCLUDED.sealed, last4 = EXCLUDED.last4`;
  invalidateAiKeys();
}

/** The usual case: an OpenRouter key under testEnv, for a route test whose model call is stubbed. */
export function seedOpenRouterKey(key = 'test-key'): Promise<void> {
  return seedAiKey(getTestDb(), testEnv, 'openrouter', key);
}

/** Back to no key at all, for a test that checks the stub path after a keyed call. */
export async function removeAiKeys(): Promise<void> {
  await getTestDb()`DELETE FROM ai_provider_keys`;
  invalidateAiKeys();
}
