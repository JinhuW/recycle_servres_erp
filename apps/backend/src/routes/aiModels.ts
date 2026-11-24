import { Hono } from 'hono';
import {
  AI_FEATURES, AI_PROVIDERS, AI_PROVIDER_LABELS, parseModelRef,
  type AiFeature, type AiModelsSetting, type AiProviderId,
} from '@recycle-erp/shared';
import { authMiddleware } from '../auth';
import { getDb, type SqlLike } from '../db';
import { log } from '../lib/log';
import { requireManager } from '../lib/role';
import { unseal } from '../lib/sealed';
import { getWorkspaceSetting } from '../lib/settings';
import { poAiReviewSetting } from '../services/poAiReview';
import { catalogue, dropCatalogue } from '../ai/catalogue';
import { fallbackModel } from '../ai/llm';
import { aiKeys, aiKeysKey, invalidateAiKeys, pushKeyToTracker, recordSync, sealKey } from '../ai/keys';
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

// Each provider's key status: whether one is saved, and its last four
// characters. A key itself never leaves the backend, except to the tracker.
// A saved key that can't be unsealed (FB_POOL_KEY rotated) serves no call, so
// it doesn't count as configured; the row is still shown so it can be removed.
aiModels.get('/providers', async (c) => {
  const sql = getDb(c.env);
  const [rows, removals] = await Promise.all([
    sql<{ provider: AiProviderId; sealed: string; last4: string; tracker_synced: boolean }[]>`
      SELECT provider, sealed, last4, tracker_synced FROM ai_provider_keys`,
    sql<{ provider: AiProviderId }[]>`SELECT provider FROM ai_provider_key_removals`,
  ]);
  const saved = new Map(rows.map((r) => [r.provider, r]));
  const removing = new Set(removals.map((r) => r.provider));
  const sealKeyBuf = aiKeysKey(c.env);
  const providers = AI_PROVIDERS.map((id) => {
    const row = saved.get(id);
    const readable = !!row && sealKeyBuf !== null && opens(row.sealed, sealKeyBuf);
    return {
      id,
      label: AI_PROVIDER_LABELS[id],
      configured: readable,
      source: row ? 'ui' : null,
      last4: row?.last4 ?? null,
      // A removal the tracker hasn't confirmed leaves it holding the old key.
      trackerSynced: row ? row.tracker_synced : removing.has(id) ? false : null,
      unreadable: !!row && !readable,
    };
  });
  return c.json({
    providers, fallbackModel: fallbackModel(await aiKeys(c.env)), canStore: sealKeyBuf !== null,
  });
});

function opens(sealed: string, key: Buffer): boolean {
  try {
    unseal(sealed, key);
    return true;
  } catch {
    return false;
  }
}

function providerParam(raw: string): AiProviderId | null {
  return (AI_PROVIDERS as readonly string[]).includes(raw) ? (raw as AiProviderId) : null;
}

const NO_SEAL_KEY = 'Keys can’t be stored until FB_POOL_KEY is set on the server';

const FEATURE_NAMES: Record<'default' | AiFeature, string> = {
  default: 'Default model', scan: 'Label scan', receipt: 'Receipt reading',
  paypal: 'PayPal screenshot', serial: 'Serial number',
};

/** The saved settings whose model runs on `provider`, named as the pages name them. */
async function settingsUsing(sql: SqlLike, provider: AiProviderId): Promise<string[]> {
  const [models, review] = await Promise.all([
    getWorkspaceSetting<AiModelsSetting>(sql, 'ai_models', { default: null }),
    poAiReviewSetting(sql),
  ]);
  const on = (ref: unknown) => typeof ref === 'string' && ref !== '' && parseModelRef(ref).provider === provider;
  const rows = (['default', ...AI_FEATURES] as const).filter((k) => on(models[k])).map((k) => FEATURE_NAMES[k]);
  const out = rows.length > 0 ? [`Settings ▸ AI models (${rows.join(', ')})`] : [];
  if (on(review.model)) out.push('Settings ▸ General ▸ AI review of purchase orders');
  return out;
}

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

  // Stored before the push, so a tracker that is down can't lose the save,
  // and the row is there to record the push's outcome and retry it from.
  const last4 = key.slice(-4);
  const sealed = sealKey(c.env, key);
  const sql = getDb(c.env);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO ai_provider_keys (provider, sealed, last4, updated_by, tracker_synced)
      VALUES (${provider}, ${sealed}, ${last4}, ${c.var.user.id}, FALSE)
      ON CONFLICT (provider) DO UPDATE SET
        sealed = EXCLUDED.sealed, last4 = EXCLUDED.last4, updated_by = EXCLUDED.updated_by,
        tracker_synced = FALSE, updated_at = NOW()`;
    // The push below replaces whatever the tracker holds, removal or not.
    await tx`DELETE FROM ai_provider_key_removals WHERE provider = ${provider}`;
  });
  invalidateAiKeys();
  dropCatalogue(provider);
  const sync = await pushKeyToTracker(c.env, provider, key);
  await recordSync(sql, provider, sealed, sync.trackerSynced);
  rlog.info('AI key saved', { provider, trackerSynced: sync.trackerSynced });
  return c.json({ ok: true, last4, ...sync });
});

aiModels.delete('/keys/:provider', async (c) => {
  const provider = providerParam(c.req.param('provider'));
  if (!provider) return c.json({ error: 'unknown provider' }, 400);
  const sql = getDb(c.env);
  const [row] = await sql<{ provider: string }[]>`
    SELECT provider FROM ai_provider_keys WHERE provider = ${provider}`;
  // Without a key every call those settings make would fail (a scan 502s, a
  // PO review runs without AI), so they are moved first.
  if (row) {
    const users = await settingsUsing(sql, provider);
    if (users.length > 0) {
      return c.json({
        error: `${AI_PROVIDER_LABELS[provider]} is still picked on ${users.join(' and ')}. `
          + 'Choose a model from another provider there before removing this key.',
        usedBy: users,
      }, 409);
    }
  }

  // Pushed first: once the row is gone, a failed push would leave nothing
  // saying the tracker still holds the key. A failure is recorded instead,
  // and the page offers a retry.
  const sync = await pushKeyToTracker(c.env, provider, null);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM ai_provider_keys WHERE provider = ${provider}`;
    if (sync.trackerSynced) {
      await tx`DELETE FROM ai_provider_key_removals WHERE provider = ${provider}`;
    } else {
      await tx`
        INSERT INTO ai_provider_key_removals (provider) VALUES (${provider})
        ON CONFLICT (provider) DO UPDATE SET requested_at = NOW()`;
    }
  });
  invalidateAiKeys();
  dropCatalogue(provider);
  rlog.info('AI key removed', { provider, trackerSynced: sync.trackerSynced });
  return c.json({ ok: true, ...sync });
});

// Pushes the provider's saved key, or its pending removal, to the tracker again.
aiModels.post('/keys/:provider/sync', async (c) => {
  const provider = providerParam(c.req.param('provider'));
  if (!provider) return c.json({ error: 'unknown provider' }, 400);
  const sql = getDb(c.env);
  const [row] = await sql<{ sealed: string }[]>`
    SELECT sealed FROM ai_provider_keys WHERE provider = ${provider}`;
  if (row) {
    const sealKeyBuf = aiKeysKey(c.env);
    if (!sealKeyBuf) return c.json({ error: NO_SEAL_KEY }, 503);
    let plain: string;
    try {
      plain = unseal(row.sealed, sealKeyBuf);
    } catch {
      return c.json({ error: 'The saved key can’t be read on this server; paste it again' }, 409);
    }
    const sync = await pushKeyToTracker(c.env, provider, plain);
    await recordSync(sql, provider, row.sealed, sync.trackerSynced);
    rlog.info('AI key re-synced', { provider, trackerSynced: sync.trackerSynced });
    return c.json({ ok: true, ...sync });
  }
  const [removal] = await sql<{ provider: string }[]>`
    SELECT provider FROM ai_provider_key_removals WHERE provider = ${provider}`;
  if (!removal) return c.json({ error: 'Nothing to sync: no key is saved here for this provider' }, 404);
  const sync = await pushKeyToTracker(c.env, provider, null);
  if (sync.trackerSynced) await sql`DELETE FROM ai_provider_key_removals WHERE provider = ${provider}`;
  rlog.info('AI key removal re-synced', { provider, trackerSynced: sync.trackerSynced });
  return c.json({ ok: true, ...sync });
});

export default aiModels;
