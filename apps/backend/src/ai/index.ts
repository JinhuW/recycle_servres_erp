// Label OCR. Two providers behind one interface:
//
//   openrouter:  frontier vision model via OpenRouter (default; best accuracy)
//   stub:        deterministic canned extraction (offline dev / tests / demo)
//
// Provider is picked by credential presence — see pickProvider. openrouter
// fails fast; the scan route turns a throw into a 502 so the field user
// retries the shot.

import type { Env, LineCategory } from '../types';
import type { ScanResult, OcrProvider } from './types';
import { stubScan } from './stub';
import { openRouterScan } from './openrouter';
import { ocrCallsTotal } from '../metrics';

export type { ScanResult, OcrProvider } from './types';
export { CONFIDENCE_FLOOR } from './types';

export function pickProvider(env: Env): OcrProvider {
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  return 'stub';
}

export async function scanLabel(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  const provider = pickProvider(env);
  try {
    const result =
      provider === 'openrouter'
        ? await openRouterScan(env, category, imageBytes)
        : await stubScan(env, category);
    // Outcome is "stub" for the canned provider (never observably "ok" from
    // a stubbed pipeline), "ok" for a successful real-model call.
    ocrCallsTotal.inc({ provider, outcome: provider === 'stub' ? 'stub' : 'ok' });
    return result;
  } catch (e) {
    ocrCallsTotal.inc({ provider, outcome: 'error' });
    throw e;
  }
}
