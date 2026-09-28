// src/ai/openrouter.ts
import type { Env, LineCategory } from '../types';
import type { ScanResult } from './types';
import { PROMPT_BY_CATEGORY, parseModelJson, EXPECTED_FIELD_COUNT } from './prompts';

// Cap on the coverage-derived confidence floor: even when the model returns
// every expected field, observable coverage alone shouldn't claim more than
// "good scan" — final ceiling stays with the model's self-rated score.
const COVERAGE_FLOOR_MAX = 0.8;

// RS-115 (2026-09-26): OpenAI gpt-6-luna for every image-AI call (labels,
// receipts, PayPal). Benchmarked on real RAM label crops with the RAM prompt
// and normalizeFields, 3 runs each: luna read 48/48 fields on 300 dpi scans
// (93/96 incl. 150 dpi) at ~$0.21 per 1k images and ~3.8 s; the previous
// gemini-2.5-flash read 96/96 at ~$0.70 per 1k and ~1.6 s. Cheaper OpenAI
// models (4o-mini, 4.1-nano, 5-nano, 5.4-nano) misread capacity/DDR/PN.
// Rollback without a deploy: OPENROUTER_OCR_MODEL=google/gemini-2.5-flash.
const DEFAULT_MODEL = 'openai/gpt-6-luna';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
// Cap each OpenRouter call so a hung/slow model can't hold a request (and a
// server worker) open indefinitely. On timeout fetch throws an AbortError,
// which scan.ts converts to a 502 "retry the shot".
const OCR_TIMEOUT_MS = 20_000;
// One budget across every attempt this call makes — the timeout retry below and
// the JSON re-ask further down. Each used to mint a *fresh* 20s signal, so a
// scan could spend 40s on the model (plus the route's 15s upload) with nothing
// bounding the pair. Sized to allow one full attempt plus most of a second.
const OCR_DEADLINE_MS = 45_000;

// Room for the answer. Reasoning models spend part of max_tokens thinking
// before they write; at the old 1024 they could run out and return nothing.
// Billing is per token used, so the headroom costs nothing on its own.
const MAX_TOKENS = 4096;

type RequestTuning = {
  /** Merged into the request body. */
  body: Record<string, unknown>;
  /** `image_url.detail`, when the model family honours it. */
  imageDetail?: 'high';
};

/**
 * Model-family specifics for the image request. OpenAI models downscale an
 * image unless asked for high detail (label text then reads as 8GB/DDR3), do
 * best with minimal reasoning, and reject `temperature`. Everything else gets
 * the request this module always sent, so a rollback to Gemini is exactly
 * the old behaviour.
 */
export function requestTuning(model: string): RequestTuning {
  if (model.startsWith('openai/')) {
    return {
      body: {
        reasoning: { effort: 'minimal', exclude: true },
        // Every prompt using this transport already asks for JSON, which
        // OpenAI's JSON mode requires.
        response_format: { type: 'json_object' },
      },
      imageDetail: 'high',
    };
  }
  return { body: { temperature: 0 } };
}

// A reply with no content at all — e.g. finish_reason "length" after the
// model spent its budget thinking. Worth one more ask, like a timeout.
class EmptyAnswerError extends Error {
  constructor() {
    super('OpenRouter: no content in response');
    this.name = 'EmptyAnswerError';
  }
}

// AbortSignal.timeout rejects with a DOMException, so match on the name rather
// than the constructor.
function isTimeout(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

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
  const dataUrl = `data:${sniffMime(bytes)};base64,${Buffer.from(bytes).toString('base64')}`;

  type ChatMessage = { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> };

  const model = env.OPENROUTER_OCR_MODEL ?? DEFAULT_MODEL;
  const tuning = requestTuning(model);
  const baseContent: Array<Record<string, unknown>> = [
    { type: 'text', text: prompt },
    {
      type: 'image_url',
      image_url: tuning.imageDetail ? { url: dataUrl, detail: tuning.imageDetail } : { url: dataUrl },
    },
  ];

  const deadline = Date.now() + OCR_DEADLINE_MS;
  const remaining = () => Math.min(OCR_TIMEOUT_MS, deadline - Date.now());

  async function askOnce(messages: ChatMessage[]): Promise<string> {
    const budget = remaining();
    if (budget <= 0) throw new Error('OpenRouter: deadline exceeded');
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://recycle-erp.local',
        'X-Title': 'Recycle ERP',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        ...tuning.body,
        messages,
      }),
      signal: AbortSignal.timeout(budget),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${res.status}: ${errBody}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new EmptyAnswerError();
    return content;
  }

  // A single slow turn was reaching the field as an error dialog on a phone
  // held over a RAM stick — the human then re-shot the same label and it came
  // back in two seconds. Retry that here instead. A timeout and an empty
  // answer are retried; an HTTP error from the model means the second attempt
  // would fail the same way.
  async function ask(messages: ChatMessage[]): Promise<string> {
    try {
      return await askOnce(messages);
    } catch (e) {
      const retryable = isTimeout(e) || e instanceof EmptyAnswerError;
      if (!retryable || remaining() <= 0) throw e;
      return askOnce(messages);
    }
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
