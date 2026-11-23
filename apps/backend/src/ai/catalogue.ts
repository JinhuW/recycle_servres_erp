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
import { aiKeys } from './keys';

const TTL_MS = 3_600_000;
// After a failed refresh the last copy is served this long before the next
// attempt, so an outage doesn't cost every dialog open a timeout.
const RETRY_MS = 300_000;
// How long a priced call waits for OpenRouter's list when nothing is cached.
const PRICE_WAIT_MS = 5_000;

const clog = log.child({ module: 'ai-models' });

type Entry = { models: AiModel[]; fetchedAt: string; expiresAt: number };

const cache = new Map<AiProviderId, Entry>();
const inflight = new Map<AiProviderId, Promise<Entry>>();
// Bumped by dropCatalogue: a fetch started before the drop (under the old
// key) must neither land in the cache nor clear a newer fetch's slot.
const generation = new Map<AiProviderId, number>();

/** `expire` keeps the cached copies but makes the next read refresh them. */
export function _resetForTests({ expire = false } = {}): void {
  inflight.clear();
  priceWaitFailedAt = 0;
  if (expire) for (const e of cache.values()) e.expiresAt = 0;
  else cache.clear();
}

function load(apiKey: string | undefined, id: AiProviderId): Promise<Entry> {
  const hit = cache.get(id);
  if (hit && Date.now() < hit.expiresAt) return Promise.resolve(hit);
  let p = inflight.get(id);
  if (!p) {
    const gen = generation.get(id) ?? 0;
    const current = () => (generation.get(id) ?? 0) === gen;
    p = PROVIDERS[id].listModels(apiKey)
      .then((models) => {
        // An empty answer would replace a good copy with a picker that offers nothing.
        if (models.length === 0) throw new Error(`${AI_PROVIDER_LABELS[id]} catalogue is empty`);
        const entry = {
          models: models.sort((a, b) => a.id.localeCompare(b.id)),
          fetchedAt: new Date().toISOString(),
          expiresAt: Date.now() + TTL_MS,
        };
        if (current()) cache.set(id, entry);
        return entry;
      })
      .catch((err: unknown) => {
        const last = current() ? cache.get(id) : undefined;
        if (!last) throw err;
        clog.warn('model catalogue refresh failed; serving the last copy', { provider: id, error: String(err) });
        last.expiresAt = Date.now() + RETRY_MS;
        return last;
      })
      .finally(() => {
        if (inflight.get(id) === p) inflight.delete(id);
      });
    inflight.set(id, p);
  }
  return p;
}

/** Forget one provider's list, e.g. after its key changed. */
export function dropCatalogue(id: AiProviderId): void {
  generation.set(id, (generation.get(id) ?? 0) + 1);
  cache.delete(id);
  inflight.delete(id);
}

/**
 * OpenAI's /v1/models says nothing about what a model can do or cost;
 * OpenRouter resells the same models as openai/<id> and says both.
 */
function withOpenRouterFacts(model: AiModel, openRouter: Map<string, AiModel>): AiModel {
  if (model.provider !== 'openai') return model;
  const twin = openRouter.get(`openai/${parseModelRef(model.id).model}`);
  if (!twin) return model;
  return {
    ...model,
    contextLength: twin.contextLength,
    promptPerM: twin.promptPerM,
    completionPerM: twin.completionPerM,
    structuredOutputs: twin.structuredOutputs,
    inputModalities: twin.inputModalities,
    outputModalities: twin.outputModalities,
  };
}

export async function catalogue(env: Env): Promise<{ models: AiModel[]; fetchedAt: string; unavailable: AiProviderId[] }> {
  const keys = await aiKeys(env);
  // A public catalogue is listed without a key; the rest need theirs.
  const ids = (Object.keys(PROVIDERS) as AiProviderId[]).filter((id) => keys[id] || PROVIDERS[id].publicCatalogue);
  // The public list is fetched without the key: a key would only add a check.
  const results = await Promise.allSettled(ids.map((id) => load(PROVIDERS[id].publicCatalogue ? undefined : keys[id], id)));
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
  const openRouter = new Map(models.filter((m) => m.provider === 'openrouter').map((m) => [m.id, m]));
  return { models: models.map((m) => withOpenRouterFacts(m, openRouter)), fetchedAt, unavailable };
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

/**
 * cachedPrice, but an OpenAI ref with nothing cached (the list is otherwise
 * fetched only when someone opens a picker) waits a few seconds for
 * OpenRouter's public list, rather than being charged the guess.
 */
let priceWaitFailedAt = 0;

export async function priceFor(ref: string): Promise<[number, number] | undefined> {
  const hit = cachedPrice(ref);
  if (hit || parseModelRef(ref).provider !== 'openai') return hit;
  // Down a moment ago: a PO review makes many calls, and each would wait.
  if (Date.now() - priceWaitFailedAt < RETRY_MS) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const wait = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PRICE_WAIT_MS);
  });
  try {
    await Promise.race([load(undefined, 'openrouter').then(() => undefined, () => undefined), wait]);
  } finally {
    clearTimeout(timer);
  }
  const price = cachedPrice(ref);
  if (!cache.has('openrouter')) priceWaitFailedAt = Date.now();
  return price;
}
