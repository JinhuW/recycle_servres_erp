// src/ai/openrouter.ts
import type { Env, LineCategory } from '../types';
import type { ScanResult } from './types';
import { PROMPT_BY_CATEGORY, parseModelJson, EXPECTED_FIELD_COUNT } from './prompts';

// Cap on the coverage-derived confidence floor: even when the model returns
// every expected field, observable coverage alone shouldn't claim more than
// "good scan" — final ceiling stays with the model's self-rated score.
const COVERAGE_FLOOR_MAX = 0.8;

const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// Cap each OpenRouter call so a hung/slow model can't hold a request (and a
// server worker) open indefinitely. On timeout fetch throws an AbortError,
// which scan.ts already converts to a 502 "retry the shot".
const OCR_TIMEOUT_MS = 20_000;

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

// Generic image→JSON transport: send one image plus a prompt, get back the
// parsed JSON object. Shared by the label scanner and the receipt renamer so
// timeout/model/retry tuning stays in one place. Throws on missing key, HTTP
// error, timeout, or (after one retry turn) unparseable JSON.
export async function openRouterImageJson(
  env: Env,
  prompt: string,
  imageBytes: ArrayBuffer,
): Promise<Record<string, unknown>> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const bytes = new Uint8Array(imageBytes);
  const dataUrl = `data:${sniffMime(bytes)};base64,${toBase64(bytes)}`;

  type ChatMessage = { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> };

  const baseContent: Array<Record<string, unknown>> = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: dataUrl } },
  ];

  async function ask(messages: ChatMessage[]): Promise<string> {
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
        temperature: 0,
        max_tokens: 1024,
        messages,
      }),
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${errBody}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenRouter: no content in response');
    return content;
  }

  const first = await ask([{ role: 'user', content: baseContent }]);
  let json = parseModelJson(first);
  if (!json) {
    // Re-send the image so the model retains visual context on the retry turn.
    const second = await ask([
      { role: 'user', content: baseContent },
      { role: 'assistant', content: first },
      { role: 'user', content: 'Your previous reply was not valid JSON. Reply with ONLY the JSON object — no prose, no code fences.' },
    ]);
    json = parseModelJson(second);
  }
  if (!json) throw new Error('OpenRouter: could not parse JSON from response');
  return json;
}

export async function openRouterScan(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  const json = await openRouterImageJson(env, PROMPT_BY_CATEGORY[category], imageBytes);

  // Pull the model's self-rated confidence out of the JSON. If it's missing or
  // not a finite number, default to 0.45 — just below the verify floor so a
  // silently-omitted score still trips the UI's "please verify" banner without
  // escalating to the "unreadable" red banner.
  const { _confidence, ...rest } = json as Record<string, unknown>;
  const raw = typeof _confidence === 'number' && Number.isFinite(_confidence) ? _confidence : null;
  const selfRated = raw === null ? 0.45 : Math.max(0, Math.min(1, raw));

  // Coverage-derived floor. The prompt tells the model to omit fields it can't
  // read, so the number of returned non-empty fields is itself a confidence
  // signal grounded in observable behaviour. This guards against the model
  // being unduly harsh on itself: if it filled 7 of 8 expected RAM fields, the
  // label was clearly readable even if its self-rating is mid-range.
  const fields = rest as Record<string, string>;
  const filled = Object.values(fields).filter((v) => typeof v === 'string' && v.trim() !== '').length;
  const expected = EXPECTED_FIELD_COUNT[category];
  const coverageFloor = expected > 0
    ? Math.min(COVERAGE_FLOOR_MAX, (filled / expected) * COVERAGE_FLOOR_MAX)
    : 0;
  const confidence = Math.max(selfRated, coverageFloor);

  return {
    category,
    confidence,
    fields,
    provider: 'openrouter',
  };
}
