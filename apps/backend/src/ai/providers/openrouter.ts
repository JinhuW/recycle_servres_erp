import { EmptyAnswerError, toBase64, type AiModel, type LlmProvider } from './types';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
const KEY_URL = 'https://openrouter.ai/api/v1/key';
const HEADERS = { 'HTTP-Referer': 'https://recycle-erp.local', 'X-Title': 'Recycle ERP' };

type RequestTuning = {
  /** Merged into the request body. */
  body: Record<string, unknown>;
  /** `image_url.detail`, when the model family honours it. */
  imageDetail?: 'high';
};

/**
 * Model-family specifics for the image request. OpenAI models downscale an
 * image unless asked for high detail (label text then reads as 8GB/DDR3), do
 * best with minimal reasoning, and reject `temperature`. Everything else gets
 * the request this module always sent, so a rollback to Gemini is exactly
 * the old behaviour.
 */
export function requestTuning(model: string): RequestTuning {
  if (model.startsWith('openai/')) {
    return {
      body: {
        reasoning: { effort: 'minimal', exclude: true },
        // Every prompt using this transport already asks for JSON, which
        // OpenAI's JSON mode requires.
        response_format: { type: 'json_object' },
      },
      imageDetail: 'high',
    };
  }
  return { body: { temperature: 0 } };
}

interface UpstreamModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
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
    // Bare: a ref without a prefix is OpenRouter, and every saved setting
    // already holds the bare id.
    id: m.id,
    provider: 'openrouter',
    name: typeof m.name === 'string' ? m.name : m.id,
    contextLength: typeof m.context_length === 'number' ? m.context_length : null,
    promptPerM: perMillion(m.pricing?.prompt),
    completionPerM: perMillion(m.pricing?.completion),
    structuredOutputs: strings(m.supported_parameters).includes('structured_outputs'),
    inputModalities: strings(m.architecture?.input_modalities),
    outputModalities: strings(m.architecture?.output_modalities),
  };
}

export const openRouterProvider: LlmProvider = {
  id: 'openrouter',
  publicCatalogue: true,

  async complete(apiKey, req) {
    // The `:online` suffix is a routing flag; the family is the model's own.
    const base = req.model.replace(/:online$/, '');
    const model = req.webSearch ? `${base}:online` : req.model;
    const tuning = requestTuning(base);
    const messages = req.turns.map((t) => {
      if (t.role === 'assistant' || !t.images?.length) {
        return { role: t.role, content: t.role === 'assistant' ? t.text : [{ type: 'text', text: t.text }] };
      }
      return {
        role: t.role,
        content: [
          { type: 'text', text: t.text },
          ...t.images.map((img) => {
            const { mime, data } = toBase64(img);
            const url = `data:${mime};base64,${data}`;
            return { type: 'image_url', image_url: tuning.imageDetail ? { url, detail: tuning.imageDetail } : { url } };
          }),
        ],
      };
    });
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens,
        ...tuning.body,
        ...(req.wantUsage ? { usage: { include: true } } : {}),
        messages,
      }),
      signal: req.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${errBody}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const usage = data.usage && {
      promptTokens: data.usage.prompt_tokens ?? 0,
      completionTokens: data.usage.completion_tokens ?? 0,
      costUsd: data.usage.cost ?? 0,
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new EmptyAnswerError('OpenRouter', usage);
    return { text, usage };
  },

  // The catalogue is public; with a key, it is the one asked for, so a key
  // being tested is checked by OpenRouter's key endpoint first.
  async listModels(apiKey) {
    if (apiKey) {
      const check = await fetch(KEY_URL, {
        signal: AbortSignal.timeout(10_000), headers: { ...HEADERS, Authorization: `Bearer ${apiKey}` },
      });
      if (!check.ok) throw new Error(`OpenRouter rejected the key (${check.status})`);
    }
    const res = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(10_000), headers: HEADERS });
    if (!res.ok) throw new Error(`OpenRouter answered ${res.status}`);
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) throw new Error('OpenRouter catalogue has no data array');
    return body.data.map(trim).filter((m): m is AiModel => m !== null);
  },
};
