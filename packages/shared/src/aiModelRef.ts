// Every model setting names its provider as a prefix: `anthropic:claude-sonnet-5-5`,
// `openai:gpt-6-luna`, `openrouter:google/gemini-2.5-flash`. A value with no
// known prefix is OpenRouter, so every id saved before providers existed still
// means what it meant. OpenRouter ids put a `/` before any `:` (`x/y:online`),
// so a prefix check can't misread one.

export const AI_PROVIDERS = ['openrouter', 'anthropic', 'openai'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AiProviderId, string> = {
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
};

export type ModelRef = { provider: AiProviderId; model: string };

const OPENROUTER_ID = /^[\w.-]+\/[\w.:-]+$/;
const DIRECT_ID = /^[\w.-]+$/;

export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf(':');
  if (i > 0) {
    const head = ref.slice(0, i);
    if ((AI_PROVIDERS as readonly string[]).includes(head)) {
      return { provider: head as AiProviderId, model: ref.slice(i + 1) };
    }
  }
  return { provider: 'openrouter', model: ref };
}

export function formatModelRef(provider: AiProviderId, model: string): string {
  return `${provider}:${model}`;
}

export function isModelRef(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 200) return false;
  const { provider, model } = parseModelRef(v);
  return provider === 'openrouter' ? OPENROUTER_ID.test(model) : DIRECT_ID.test(model);
}

/** The features whose model is picked on Settings ▸ AI models. */
export const AI_FEATURES = ['scan', 'receipt', 'paypal', 'serial'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** The `ai_models` workspace setting. null → the default. */
export type AiModelsSetting = { default: string | null } & Partial<Record<AiFeature, string | null>>;

export function isAiModelsSetting(v: unknown): v is AiModelsSetting {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = ['default', ...AI_FEATURES];
  return Object.keys(o).every((k) => keys.includes(k))
    && keys.every((k) => o[k] === undefined || o[k] === null || isModelRef(o[k]));
}
