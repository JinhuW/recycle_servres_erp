// Label OCR. Three providers behind one interface:
//
//   openrouter:  frontier vision model via OpenRouter (default; best accuracy)
//   workers-ai:  Cloudflare Workers AI vision (Llama 3.2 11B vision-instruct)
//   stub:        deterministic canned extraction (offline dev / tests / demo)
//
// Provider is picked by credential/binding presence — see pickProvider.
// openrouter and workers-ai fail fast; the scan route turns a throw into a
// 502 so the field user retries the shot.

import type { Env, LineCategory } from '../types';
import type { ScanResult, OcrProvider } from './types';
import { stubScan } from './stub';
import { workersAiScan } from './workers-ai';
import { openRouterScan } from './openrouter';

export type { ScanResult, OcrProvider } from './types';
export { CONFIDENCE_FLOOR } from './types';

export function pickProvider(env: Env): OcrProvider {
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  if (env.AI) return 'workers-ai';
  return 'stub';
}

export async function scanLabel(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  switch (pickProvider(env)) {
    case 'openrouter':
      return openRouterScan(env, category, imageBytes);
    case 'workers-ai':
      return workersAiScan(env, category, imageBytes);
    default:
      return stubScan(env, category);
  }
}
