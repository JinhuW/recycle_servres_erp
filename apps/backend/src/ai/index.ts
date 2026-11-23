// Label OCR and the other image reads. Any provider in ./providers can serve
// them, chosen per feature on Settings ▸ AI models (ai/llm.ts resolves which).
// With no provider key at all, a deterministic stub returns canned data
// (offline dev / tests / demo). Real calls fail fast; the scan route turns a
// throw into a 502 so the field user retries the shot.

import { parseModelRef, type AiFeature } from '@recycle-erp/shared';
import type { Env, LineCategory } from '../types';
import type { ScanResult, OcrProvider } from './types';
import { stubScan } from './stub';
import { aiScan, envModel, resolveModel } from './llm';
import { PROVIDERS, anyProviderConfigured } from './providers';
import { ocrCallsTotal } from '../metrics';
import { log } from '../lib/log';

const aiLog = log.child({ module: 'ai' });

export type { ScanResult, OcrProvider } from './types';

// Mode for /api/health, without side effects: a probe must not log. The env
// default's provider when its key is set, else whichever provider has one.
export function describeOcr(env: Env): OcrProvider {
  if (!anyProviderConfigured(env)) return 'stub';
  const p = parseModelRef(envModel(env)).provider;
  if (PROVIDERS[p].configured(env)) return p;
  return Object.values(PROVIDERS).find((x) => x.configured(env))!.id;
}

let warnedAboutStub = false;
export function pickProvider(env: Env): OcrProvider {
  const p = describeOcr(env);
  // Loud one-shot WARN so the dev console can't quietly swallow the fallback
  // — prod boot already refuses (see env.ts), this catches dev/CI.
  if (p === 'stub' && !warnedAboutStub) {
    warnedAboutStub = true;
    aiLog.warn(
      'No AI provider key is set (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY) — falling back to STUB OCR. Extractions will be canned data with a hardcoded confidence.',
    );
  }
  return p;
}

/** The provider `feature`'s calls go to, or the stub when no key is set at all. */
export async function featureProvider(env: Env, feature: AiFeature): Promise<OcrProvider> {
  if (pickProvider(env) === 'stub') return 'stub';
  return parseModelRef(await resolveModel(env, { feature })).provider;
}

export async function scanLabel(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  const provider = await featureProvider(env, 'scan');
  try {
    const result =
      provider === 'stub'
        ? await stubScan(env, category)
        : await aiScan(env, category, imageBytes, { feature: 'scan' });
    // Outcome is "stub" for the canned provider (never observably "ok" from
    // a stubbed pipeline), "ok" for a successful real-model call.
    ocrCallsTotal.inc({ provider, outcome: provider === 'stub' ? 'stub' : 'ok' });
    return result;
  } catch (e) {
    ocrCallsTotal.inc({ provider, outcome: 'error' });
    throw e;
  }
}
