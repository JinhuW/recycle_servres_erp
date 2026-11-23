// The model pickers' catalogue: every configured provider's models, merged.
// The browser can't reach the providers (CSP, and every call goes through
// lib/api.ts), so this fetches each list, keeps what a picker shows, and
// holds it for an hour: OpenRouter's raw list alone is ~800 KB and changes a
// few times a day. Each provider is cached on its own, so one outage costs
// only its own entries.

import { AI_PROVIDER_LABELS, parseModelRef, type AiProviderId } from '@recycle-erp/shared';
import type { Env } from '../types';
import { log } from '../lib/log';
import { PROVIDERS, type AiModel } from './providers';

const TTL_MS = 3_600_000;
// After a failed refresh the last copy is served this long before the next
// attempt, so an outage doesn't cost every dialog open a timeout.
const RETRY_MS = 300_000;

const clog = log.child({ module: 'ai-models' });

type Entry = { models: AiModel[]; fetchedAt: string; expiresAt: number };

const cache = new Map<AiProviderId, Entry>();
const inflight = new Map<AiProviderId, Promise<Entry>>();

/** `expire` keeps the cached copies but makes the next read refresh them. */
export function _resetForTests({ expire = false } = {}): void {
  inflight.clear();
  if (expire) for (const e of cache.values()) e.expiresAt = 0;
  else cache.clear();
}

function load(env: Env, id: AiProviderId): Promise<Entry> {
  const hit = cache.get(id);
  if (hit && Date.now() < hit.expiresAt) return Promise.resolve(hit);
  let p = inflight.get(id);
  if (!p) {
    p = PROVIDERS[id].listModels(env)
      .then((models) => {
        // An empty answer would replace a good copy with a picker that offers nothing.
        if (models.length === 0) throw new Error(`${AI_PROVIDER_LABELS[id]} catalogue is empty`);
        const entry = {
          models: models.sort((a, b) => a.id.localeCompare(b.id)),
          fetchedAt: new Date().toISOString(),
          expiresAt: Date.now() + TTL_MS,
        };
        cache.set(id, entry);
        return entry;
      })
      .catch((err: unknown) => {
        const last = cache.get(id);
        if (!last) throw err;
        clog.warn('model catalogue refresh failed; serving the last copy', { provider: id, error: String(err) });
        last.expiresAt = Date.now() + RETRY_MS;
        return last;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

/** Providers the picker lists: OpenRouter's catalogue is public, the rest need their key. */
function listed(env: Env): AiProviderId[] {
  return (Object.keys(PROVIDERS) as AiProviderId[])
    .filter((id) => id === 'openrouter' || PROVIDERS[id].configured(env));
}

export async function catalogue(env: Env): Promise<{ models: AiModel[]; fetchedAt: string; unavailable: AiProviderId[] }> {
  const ids = listed(env);
  const results = await Promise.allSettled(ids.map((id) => load(env, id)));
  const models: AiModel[] = [];
  const unavailable: AiProviderId[] = [];
  let fetchedAt = '';
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      models.push(...r.value.models);
      if (!fetchedAt || r.value.fetchedAt < fetchedAt) fetchedAt = r.value.fetchedAt;
    } else {
      clog.warn('model catalogue unreachable', { provider: ids[i], error: String(r.reason) });
      unavailable.push(ids[i]!);
    }
  });
  if (models.length === 0) {
    throw new Error(`Model catalogue unreachable: ${unavailable.map((id) => AI_PROVIDER_LABELS[id]).join(', ')}`);
  }
  return { models, fetchedAt, unavailable };
}

/**
 * Price of a model ref, from whatever copy is cached; never fetches. OpenAI's
 * API lists no prices, but OpenRouter resells its models at OpenAI's rates.
 */
export function cachedPrice(ref: string): [number, number] | undefined {
  const { provider, model } = parseModelRef(ref);
  const lookups: Array<[AiProviderId, string]> = provider === 'openai'
    ? [['openai', ref], ['openrouter', `openai/${model}`]]
    : [[provider, provider === 'openrouter' ? model : ref]];
  for (const [p, id] of lookups) {
    const m = cache.get(p)?.models.find((x) => x.id === id);
    if (m && m.promptPerM !== null && m.completionPerM !== null) return [m.promptPerM, m.completionPerM];
  }
  return undefined;
}
