// Model refs: the llm_model settings name a provider as well as a model.
// Values stored before providers existed carry no prefix and are OpenRouter
// ids, so an unknown or missing prefix still means OpenRouter.

export type Provider = 'openrouter' | 'anthropic' | 'openai';

export interface ModelRef {
  provider: Provider;
  model: string;
}

// Only these exact prefixes count: `openai/gpt-…` and `x/y:online` are
// OpenRouter ids, not refs.
const PREFIXED = /^(anthropic|openai|openrouter):([\s\S]*)$/;
const OPENROUTER_ID = /^[\w.-]+\/[\w.:-]+$/;
const DIRECT_ID = /^[\w.-]+$/;

export function parseModelRef(ref: string): ModelRef {
  const match = PREFIXED.exec(ref);
  if (!match) return {provider: 'openrouter', model: ref};
  return {provider: match[1] as Provider, model: match[2]!};
}

export function isModelRef(ref: string): boolean {
  const {provider, model} = parseModelRef(ref);
  return provider === 'openrouter' ? OPENROUTER_ID.test(model) : DIRECT_ID.test(model);
}
