// The provider registry. A new provider is one file implementing LlmProvider
// and one line here (plus its id in packages/shared/src/aiModelRef.ts).
import type { AiProviderId } from '@recycle-erp/shared';
import type { Env } from '../../types';
import type { LlmProvider } from './types';
import { openRouterProvider } from './openrouter';
import { anthropicProvider } from './anthropic';
import { openAiProvider } from './openai';

export const PROVIDERS: Record<AiProviderId, LlmProvider> = {
  openrouter: openRouterProvider,
  anthropic: anthropicProvider,
  openai: openAiProvider,
};

export function anyProviderConfigured(env: Env): boolean {
  return Object.values(PROVIDERS).some((p) => p.configured(env));
}

export * from './types';
