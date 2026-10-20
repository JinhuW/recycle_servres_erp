import { Hono } from 'hono';
import { authMiddleware } from '../auth';
import { log } from '../lib/log';
import { requireManager } from '../lib/role';
import type { Env, User } from '../types';

// ─── OpenRouter model catalogue ───────────────────────────────────────────────
// The model fields pick from OpenRouter's public catalogue. The browser can't
// reach openrouter.ai (CSP, and every call goes through lib/api.ts), so this
// fetches it, keeps what a picker shows, and holds it for an hour: the raw
// list is ~800 KB and changes a few times a day. No key: the endpoint is
// public, so dev and CI without OPENROUTER_API_KEY see the same list.

const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
const TTL_MS = 3_600_000;
// After a failed refresh the last copy is served this long before the next
// attempt, so an OpenRouter outage doesn't cost every dialog open a timeout.
const RETRY_MS = 300_000;
const TIMEOUT_MS = 10_000;

const rlog = log.child({ module: 'ai-models' });

export interface AiModel {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per million tokens; null for routers, which price what they route to. */
  promptPerM: number | null;
  completionPerM: number | null;
  /** Honours a strict `response_format` JSON schema, which the tracker's evaluator sends. */
  structuredOutputs: boolean;
  inputModalities: string[];
  outputModalities: string[];
}

interface Catalogue {
  models: AiModel[];
  fetchedAt: string;
}

interface UpstreamModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
}

let cache: { body: Catalogue; expiresAt: number } | null = null;
let inflight: Promise<Catalogue> | null = null;

/** `expire` keeps the cached copy but makes the next read refresh it. */
export function _resetForTests({ expire = false } = {}): void {
  inflight = null;
  if (expire && cache) cache.expiresAt = 0;
  else cache = null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function perMillion(raw: unknown): number | null {
  const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  // Routers (openrouter/auto) carry -1: their price is the routed model's.
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6 * 10_000) / 10_000;
}

function trim(raw: unknown): AiModel | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as UpstreamModel;
  if (typeof m.id !== 'string' || m.id === '') return null;
  return {
    id: m.id,
    name: typeof m.name === 'string' ? m.name : m.id,
    contextLength: typeof m.context_length === 'number' ? m.context_length : null,
    promptPerM: perMillion(m.pricing?.prompt),
    completionPerM: perMillion(m.pricing?.completion),
    structuredOutputs: strings(m.supported_parameters).includes('structured_outputs'),
    inputModalities: strings(m.architecture?.input_modalities),
    outputModalities: strings(m.architecture?.output_modalities),
  };
}

async function fetchCatalogue(): Promise<Catalogue> {
  const res = await fetch(CATALOGUE_URL, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'HTTP-Referer': 'https://recycle-erp.local', 'X-Title': 'Recycle ERP' },
  });
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error('OpenRouter catalogue has no data array');
  const models = body.data
    .map(trim)
    .filter((m): m is AiModel => m !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  // An empty answer would replace a good copy with a picker that offers nothing.
  if (models.length === 0) throw new Error('OpenRouter catalogue is empty');
  return { models, fetchedAt: new Date().toISOString() };
}

function catalogue(): Promise<Catalogue> {
  if (cache && Date.now() < cache.expiresAt) return Promise.resolve(cache.body);
  inflight ??= fetchCatalogue()
    .then((body) => {
      cache = { body, expiresAt: Date.now() + TTL_MS };
      return body;
    })
    .catch((err: unknown) => {
      if (!cache) throw err;
      rlog.warn('model catalogue refresh failed; serving the last copy', err);
      cache.expiresAt = Date.now() + RETRY_MS;
      return cache.body;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const aiModels = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', requireManager);

aiModels.get('/models', async (c) => {
  try {
    return c.json(await catalogue());
  } catch (err) {
    rlog.warn('model catalogue unreachable', err);
    return c.json({ error: 'OpenRouter’s model catalogue is unreachable' }, 502);
  }
});

export default aiModels;
