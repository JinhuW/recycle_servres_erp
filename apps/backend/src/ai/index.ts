// Label OCR and the other image reads. Any provider in ./providers can serve
// them, chosen per feature on Settings ▸ AI models (ai/llm.ts resolves which),
// with keys pasted there or set in env (ai/keys.ts). With no key at all, dev
// and CI get a deterministic stub; production refuses instead, because canned
// data would be trusted as real readings. Real calls fail fast; the scan
// route turns a throw into a 502 so the field user retries the shot.

import { AI_PROVIDERS, parseModelRef, type AiFeature } from '@recycle-erp/shared';
import type { Env, LineCategory } from '../types';
import type { ScanResult, OcrProvider } from './types';
import { stubScan } from './stub';
import { aiScan, fallbackModel, resolveModel, resolveModelForHealth } from './llm';
import { aiKeys, aiKeysForHealth, type AiKeys } from './keys';
import { ocrCallsTotal } from '../metrics';
import { log } from '../lib/log';

const aiLog = log.child({ module: 'ai' });

export type { ScanResult, OcrProvider } from './types';
export { modelHasKey, providerHasKey } from './keys';

export const NO_KEY_ERROR = 'No AI provider key is set: add one on Settings ▸ AI models';

function choose(env: Env, keys: AiKeys): OcrProvider {
  if (!AI_PROVIDERS.some((p) => keys[p])) return 'stub';
  return parseModelRef(fallbackModel(env, keys)).provider;
}

/**
 * Mode for /api/health: the provider label scans actually go to, or 'none'
 * when that provider has no key and they fail. A probe must not log, and
 * reads the database only while the caches are cold after a restart.
 */
export async function describeOcr(env: Env): Promise<OcrProvider | 'none'> {
  const keys = await aiKeysForHealth(env);
  if (choose(env, keys) === 'stub') return env.NODE_ENV === 'production' ? 'none' : 'stub';
  const p = parseModelRef(await resolveModelForHealth(env, keys, { feature: 'scan' })).provider;
  return keys[p] ? p : 'none';
}

let warnedAboutStub = false;
/** 'stub' when no key is set anywhere; outside production only, see featureProvider. */
export async function pickProvider(env: Env): Promise<OcrProvider> {
  const p = choose(env, await aiKeys(env));
  // Loud one-shot WARN so the dev console can't quietly swallow the fallback.
  if (p === 'stub' && !warnedAboutStub && env.NODE_ENV !== 'production') {
    warnedAboutStub = true;
    aiLog.warn('No AI provider key is set — falling back to STUB OCR. Extractions will be canned data with a hardcoded confidence.');
  }
  return p;
}

/** The provider `feature`'s calls go to; the stub only outside production. */
export async function featureProvider(env: Env, feature: AiFeature): Promise<OcrProvider> {
  if ((await pickProvider(env)) === 'stub') {
    if (env.NODE_ENV === 'production') throw new Error(NO_KEY_ERROR);
    return 'stub';
  }
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
