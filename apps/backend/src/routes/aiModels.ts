import { Hono } from 'hono';
import { AI_PROVIDERS, AI_PROVIDER_LABELS, type AiProviderId } from '@recycle-erp/shared';
import { authMiddleware } from '../auth';
import { getDb } from '../db';
import { log } from '../lib/log';
import { requireManager } from '../lib/role';
import { catalogue, dropCatalogue } from '../ai/catalogue';
import { envModel } from '../ai/llm';
import { aiKeysKey, invalidateAiKeys, KEY_ENV, pushKeyToTracker, sealKey } from '../ai/keys';
import { PROVIDERS } from '../ai/providers';
import type { Env, User } from '../types';

export { _resetForTests } from '../ai/catalogue';

const rlog = log.child({ module: 'ai-models' });
const MAX_KEY_LENGTH = 500;

const aiModels = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', requireManager);

aiModels.get('/models', async (c) => {
  try {
    return c.json(await catalogue(c.env));
  } catch (err) {
    rlog.warn('model catalogue unreachable', err);
    return c.json({ error: err instanceof Error ? err.message : 'Model catalogue unreachable' }, 502);
  }
});

// Each provider's key status: where it comes from and its last four
// characters. A key itself never leaves the backend, except to the tracker.
aiModels.get('/providers', async (c) => {
  const rows = await getDb(c.env)<{ provider: AiProviderId; last4: string; tracker_synced: boolean }[]>`
    SELECT provider, last4, tracker_synced FROM ai_provider_keys`;
  const saved = new Map(rows.map((r) => [r.provider, r]));
  const providers = AI_PROVIDERS.map((id) => {
    const row = saved.get(id);
    const fromEnv = !!c.env[KEY_ENV[id]]?.trim();
    return {
      id,
      label: AI_PROVIDER_LABELS[id],
      configured: !!row || fromEnv,
      source: row ? 'ui' : fromEnv ? 'env' : null,
      last4: row?.last4 ?? null,
      trackerSynced: row ? row.tracker_synced : null,
      keyName: KEY_ENV[id],
    };
  });
  return c.json({ providers, envModel: envModel(c.env), canStore: aiKeysKey(c.env) !== null });
});

function providerParam(raw: string): AiProviderId | null {
  return (AI_PROVIDERS as readonly string[]).includes(raw) ? (raw as AiProviderId) : null;
}

const NO_SEAL_KEY = 'Keys can’t be stored until FB_POOL_KEY is set on the server';

aiModels.put('/keys/:provider', async (c) => {
  const provider = providerParam(c.req.param('provider'));
  if (!provider) return c.json({ error: 'unknown provider' }, 400);
  if (!aiKeysKey(c.env)) return c.json({ error: NO_SEAL_KEY }, 503);
  const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!key || key.length > MAX_KEY_LENGTH || /\s/.test(key)) return c.json({ error: 'key required' }, 400);

  // Tested before it is stored: listing models spends nothing and fails on a
  // bad key, so a typo is caught here instead of at the next scan.
  try {
    await PROVIDERS[provider].listModels(key);
  } catch (e) {
    rlog.info('AI key test failed', { provider });
    const why = e instanceof Error ? e.message.slice(0, 200) : 'the provider refused it';
    return c.json({ error: `${AI_PROVIDER_LABELS[provider]} rejected this key: ${why}` }, 400);
  }

  const last4 = key.slice(-4);
  const sync = await pushKeyToTracker(c.env, provider, key);
  await getDb(c.env)`
    INSERT INTO ai_provider_keys (provider, sealed, last4, updated_by, tracker_synced)
    VALUES (${provider}, ${sealKey(c.env, key)}, ${last4}, ${c.var.user.id}, ${sync.trackerSynced})
    ON CONFLICT (provider) DO UPDATE SET
      sealed = EXCLUDED.sealed, last4 = EXCLUDED.last4, updated_by = EXCLUDED.updated_by,
      tracker_synced = EXCLUDED.tracker_synced, updated_at = NOW()`;
  invalidateAiKeys();
  dropCatalogue(provider);
  rlog.info('AI key saved', { provider, trackerSynced: sync.trackerSynced });
  return c.json({ ok: true, last4, ...sync });
});

aiModels.delete('/keys/:provider', async (c) => {
  const provider = providerParam(c.req.param('provider'));
  if (!provider) return c.json({ error: 'unknown provider' }, 400);
  await getDb(c.env)`DELETE FROM ai_provider_keys WHERE provider = ${provider}`;
  invalidateAiKeys();
  dropCatalogue(provider);
  const sync = await pushKeyToTracker(c.env, provider, null);
  rlog.info('AI key removed', { provider, trackerSynced: sync.trackerSynced });
  return c.json({ ok: true, ...sync });
});

export default aiModels;
