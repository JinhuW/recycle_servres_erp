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
import { log } from '../lib/log';

const aiLog = log.child({ module: 'ai' });

export type { ScanResult, OcrProvider } from './types';

let warnedAboutStub = false;
export function pickProvider(env: Env): OcrProvider {
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  // Loud one-shot WARN so the dev console can't quietly swallow the fallback
  // — prod boot already refuses (see env.ts), this catches dev/CI.
  if (!warnedAboutStub) {
    warnedAboutStub = true;
    aiLog.warn(
      'OPENROUTER_API_KEY is not set — falling back to STUB OCR. Extractions will be canned data with a hardcoded confidence. Set OPENROUTER_API_KEY to enable real label scanning.',
    );
  }
  return 'stub';
}

// Mode for /api/health. Same conditions as pickProvider, but without its
// one-shot warning — a probe must not have side effects. The silent fallback is
// exactly what makes this worth reporting: a prod missing the key scans fine and
// returns canned data.
export function describeOcr(env: Env): OcrProvider {
  return env.OPENROUTER_API_KEY ? 'openrouter' : 'stub';
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
