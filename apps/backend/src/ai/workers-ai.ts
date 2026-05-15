// src/ai/workers-ai.ts
import type { Env, LineCategory } from '../types';
import type { ScanResult } from './types';
import { PROMPT_BY_CATEGORY, parseModelJson } from './prompts';

export async function workersAiScan(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  // Workers AI llava vision call. We pass the raw image bytes (max ~4MB).
  const ai = env.AI!;
  const response = (await ai.run('@cf/meta/llama-3.2-11b-vision-instruct', {
    image: Array.from(new Uint8Array(imageBytes)),
    prompt: PROMPT_BY_CATEGORY[category],
    max_tokens: 256,
  })) as { response?: string; description?: string };

  const text = (response.response ?? response.description ?? '').trim();
  const json = parseModelJson(text);

  return {
    category,
    confidence: json ? 0.85 : 0.4,
    fields: (json ?? {}) as Record<string, string>,
    provider: 'workers-ai',
  };
}
