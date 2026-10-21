import { api } from './api';

/** One entry of OpenRouter's catalogue, as the backend trims it. */
export type AiModel = {
  id: string;
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

/** Called on logout, beside the other per-session caches. */
export function resetAiModels(): void {
  cached = null;
  inflight = null;
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
