// src/ai/openrouter.ts
import type { Env, LineCategory } from '../types';
import type { ScanResult } from './types';
import { PROMPT_BY_CATEGORY, parseModelJson } from './prompts';

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function openRouterScan(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const bytes = new Uint8Array(imageBytes);
  const dataUrl = `data:${sniffMime(bytes)};base64,${toBase64(bytes)}`;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://recycle-erp.local',
      'X-Title': 'Recycle ERP',
    },
    body: JSON.stringify({
      model: env.OPENROUTER_OCR_MODEL ?? DEFAULT_MODEL,
      temperature: 0.1,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT_BY_CATEGORY[category] },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter: no content in response');

  const json = parseModelJson(content);
  if (!json) throw new Error('OpenRouter: could not parse JSON from response');

  return {
    category,
    confidence: 0.85,
    fields: json as Record<string, string>,
    provider: 'openrouter',
  };
}
