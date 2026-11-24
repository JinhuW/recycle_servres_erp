import { isModelRef, parseModelRef, type AiProviderId } from '@recycle-erp/shared';
import { api } from './api';

/**
 * One entry of the model catalogue, as the backend trims it. `id` is a model
 * ref: bare for OpenRouter, `anthropic:…` / `openai:…` for the others.
 */
export type AiModel = {
  id: string;
  provider: AiProviderId;
  name: string;
  contextLength: number | null;
  /** USD per million tokens; null for routers, which price what they route to. */
  promptPerM: number | null;
  completionPerM: number | null;
  structuredOutputs: boolean;
  inputModalities: string[];
  outputModalities: string[];
};

/**
 * Text models that honour a strict JSON schema as `response_format`, which is
 * how the Reddit tracker's evaluator asks for its verdict.
 */
export const TEXT_JSON_MODEL = (m: AiModel): boolean =>
  m.structuredOutputs && m.outputModalities.includes('text');

/** Models that read a photo and answer in text: every image AI read. */
export const READS_IMAGES = (m: AiModel): boolean =>
  m.inputModalities.includes('image') && m.outputModalities.includes('text');

/**
 * `provider`'s models that `filter` lets through. isModelRef drops ids a
 * setting can't hold, such as OpenRouter's `~vendor/model-latest` aliases,
 * which sort first and would otherwise be preselected and then refused.
 */
export function modelsFor(provider: AiProviderId, filter?: (m: AiModel) => boolean): (m: AiModel) => boolean {
  return m => m.provider === provider && isModelRef(m.id) && (!filter || filter(m));
}

/**
 * The model to preselect when `provider` is picked: its first listed model
 * the row's filter vouches for, else ''. With no filter nothing is
 * preselected, because capabilities the catalogue doesn't know are reported
 * as missing, and an unchecked first entry could be one that can't do the job.
 */
export function preselectModel(
  models: readonly AiModel[] | null, provider: AiProviderId, filter?: (m: AiModel) => boolean,
): string {
  if (!filter) return '';
  return (models ?? []).find(modelsFor(provider, filter))?.id ?? '';
}

/** The i18n key of the hint for a model ref whose shape is wrong, by its provider. */
export function modelShapeHintKey(ref: string): 'trkModelInvalid' | 'trkModelInvalidDirect' {
  return parseModelRef(ref).provider === 'openrouter' ? 'trkModelInvalid' : 'trkModelInvalidDirect';
}

let cached: AiModel[] | null = null;
let inflight: Promise<AiModel[]> | null = null;

/** The catalogue, fetched once per session; the backend refreshes it hourly. */
export function loadAiModels(): Promise<AiModel[]> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const data = await api.get<{ models: AiModel[] }>('/api/ai/models');
      cached = data.models;
      return cached;
    } finally {
      // Cleared either way: a failed load must stay retry-able.
      inflight = null;
    }
  })();
  return inflight;
}

export type AiProviderStatus = {
  id: AiProviderId;
  label: string;
  configured: boolean;
  /** 'ui': a key is saved on Settings ▸ AI models (pasted, or imported from the old env var). */
  source: 'ui' | null;
  last4: string | null;
  /**
   * For a pasted key: whether the Reddit tracker has it too. For a removed
   * one: false while the tracker hasn't confirmed the removal.
   */
  trackerSynced: boolean | null;
  /** A saved key this server can't unseal (FB_POOL_KEY rotated): it serves no call. */
  unreadable?: boolean;
};

/** `fallbackModel`: what a call uses when no model is picked on the page. */
export type AiProvidersInfo = { providers: AiProviderStatus[]; fallbackModel: string; canStore: boolean };

let providers: Promise<AiProvidersInfo> | null = null;

/** Which providers have a key on the server; fetched once per session. */
export function loadAiProviders(): Promise<AiProvidersInfo> {
  providers ??= api.get<AiProvidersInfo>('/api/ai/providers')
    .catch((e: unknown) => { providers = null; throw e; });
  return providers;
}

export type KeySaveResult = { ok: true; last4?: string; trackerSynced: boolean; trackerError?: string };

/** Tests and saves a provider key; the model list and key status reload after. */
export async function saveAiKey(provider: AiProviderId, key: string): Promise<KeySaveResult> {
  const r = await api.put<KeySaveResult>(`/api/ai/keys/${provider}`, { key });
  resetAiModels();
  return r;
}

export async function removeAiKey(provider: AiProviderId): Promise<KeySaveResult> {
  const r = await api.delete<KeySaveResult>(`/api/ai/keys/${provider}`);
  resetAiModels();
  return r;
}

/** Pushes the saved key, or its removal, to the Reddit tracker again. */
export async function resyncAiKey(provider: AiProviderId): Promise<KeySaveResult> {
  const r = await api.post<KeySaveResult>(`/api/ai/keys/${provider}/sync`, {});
  providers = null;
  return r;
}

/** Called on logout, beside the other per-session caches. */
export function resetAiModels(): void {
  cached = null;
  inflight = null;
  providers = null;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function usd(n: number, locale: string): string {
  // Three significant digits, never fewer than two decimals: $0.15, $0.60,
  // $15.00, $0.0375.
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4,
  }).format(Number(n.toPrecision(3)));
}

/** The grey text beside a model in the picker: price per million tokens and context size. */
export function modelMeta(m: AiModel, locale: string, t: Translate): string {
  const parts: string[] = [];
  if (m.promptPerM !== null && m.completionPerM !== null) {
    parts.push(m.promptPerM === 0 && m.completionPerM === 0
      ? t('aiModelFree')
      : t('aiModelPrice', { prompt: usd(m.promptPerM, locale), completion: usd(m.completionPerM, locale) }));
  }
  if (m.contextLength) {
    const n = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
      .format(m.contextLength);
    parts.push(t('aiModelContext', { n }));
  }
  return parts.join(' · ');
}
