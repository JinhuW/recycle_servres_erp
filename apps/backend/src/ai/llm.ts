// The provider-agnostic core of every model call: which model a call uses,
// the deadline, the retry on a slow or empty turn, and the JSON re-ask. The
// providers (./providers) only send one turn and read the answer.

import sharp from 'sharp';
import {
  AI_PROVIDERS, AI_PROVIDER_LABELS, parseModelRef, type AiFeature, type AiModelsSetting, type AiProviderId,
} from '@recycle-erp/shared';
import type { Env, LineCategory } from '../types';
import type { ScanResult } from './types';
import { getDb } from '../db';
import { getWorkspaceSetting } from '../lib/settings';
import { log } from '../lib/log';
import { PROVIDERS, EmptyAnswerError, RefusalError, type AiUsage, type Turn } from './providers';
import { priceFor } from './catalogue';
import { aiKeys, KEY_ENV, type AiKeys } from './keys';
import { PROMPT_BY_CATEGORY, parseModelJson, EXPECTED_FIELD_COUNT, EXPECTED_FIELDS_BY_CATEGORY } from './prompts';

export type { AiUsage } from './providers';

const llog = log.child({ module: 'ai' });

// OpenAI gpt-6-luna for every image-AI call (labels, receipts, PayPal),
// chosen 2026-09-26. Benchmarked on real RAM label crops with the RAM prompt
// and normalizeFields, 3 runs each: luna read 48/48 fields on 300 dpi scans
// (93/96 incl. 150 dpi) at ~$0.21 per 1k images and ~3.8 s; the previous
// gemini-2.5-flash read 96/96 at ~$0.70 per 1k and ~1.6 s. Cheaper OpenAI
// models (4o-mini, 4.1-nano, 5-nano, 5.4-nano) misread capacity/DDR/PN.
// Switched on Settings ▸ AI models now; AI_MODEL / OPENROUTER_OCR_MODEL set
// the fallback.
const DEFAULT_MODEL = 'openai/gpt-6-luna';
// The fallback when only another provider has a key: the same model direct
// from OpenAI, and for Claude the mid-priced current model.
const PROVIDER_DEFAULT: Record<AiProviderId, string> = {
  openrouter: DEFAULT_MODEL,
  openai: 'openai:gpt-6-luna',
  anthropic: 'anthropic:claude-sonnet-5-5',
};

// Cap on the coverage-derived confidence floor: even when the model returns
// every expected field, observable coverage alone shouldn't claim more than
// "good scan" — final ceiling stays with the model's self-rated score.
const COVERAGE_FLOOR_MAX = 0.8;
// Cap each call so a hung/slow model can't hold a request (and a server
// worker) open indefinitely. On timeout the call throws, which scan.ts
// converts to a 502 "retry the shot".
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
// Settings ▸ AI models is read at most this often; a save clears it.
const SETTING_TTL_MS = 30_000;
// Anthropic refuses an image over 8000 px a side or 5 MB of base64, and
// downsamples anything past 2576 px itself; a phone photo or a long PayPal
// screenshot passes both. Shrunk here, for every provider, to what the
// models read anyway.
const MAX_IMAGE_EDGE = 2576;
const MAX_IMAGE_BYTES = 3_500_000;

export type AiCallOptions = {
  /** A model ref that wins over every setting. */
  model?: string;
  /** Which Settings ▸ AI models row picks the model. */
  feature?: AiFeature;
  /** Called once per model turn with what it cost. */
  onUsage?: (u: AiUsage) => void;
  /** Per-attempt cap; a web-search turn reads pages before it answers. */
  timeoutMs?: number;
  webSearch?: boolean;
};

let setting: { value: AiModelsSetting; expiresAt: number } | null = null;
// Bumped on save, so a read that started before it can't cache the old value.
let settingGeneration = 0;

export function invalidateAiModelsSetting(): void {
  settingGeneration++;
  setting = null;
}

async function aiModelsSetting(env: Env, { quiet = false } = {}): Promise<AiModelsSetting> {
  if (setting && Date.now() < setting.expiresAt) return setting.value;
  if (!env.DATABASE_URL) return { default: null };
  const gen = settingGeneration;
  try {
    const value = await getWorkspaceSetting<AiModelsSetting>(getDb(env), 'ai_models', { default: null });
    if (gen === settingGeneration) setting = { value, expiresAt: Date.now() + SETTING_TTL_MS };
    return value;
  } catch (e) {
    // A database blip must not fail a scan that the env default can serve.
    if (!quiet) llog.warn('could not read ai_models; using the env default', e);
    return setting?.value ?? { default: null };
  }
}

/** The model a call falls back to when Settings ▸ AI models names none and its key is set. */
export function envModel(env: Env): string {
  return env.AI_MODEL ?? env.OPENROUTER_OCR_MODEL ?? DEFAULT_MODEL;
}

/**
 * The last resort: the env model, unless only other providers have a key, in
 * which case a default model of the first of those. With no key anywhere it
 * is the env model, and the call fails naming the key it needs.
 */
export function fallbackModel(env: Env, keys: AiKeys): string {
  const ref = envModel(env);
  if (keys[parseModelRef(ref).provider]) return ref;
  const keyed = AI_PROVIDERS.find((p) => keys[p]);
  return keyed ? PROVIDER_DEFAULT[keyed] : ref;
}

function pick(s: AiModelsSetting, env: Env, keys: AiKeys, opts: AiCallOptions): string {
  return opts.model || (opts.feature && s[opts.feature]) || s.default || fallbackModel(env, keys);
}

/** The model a call with `opts` uses: override → feature → default → env → any keyed provider. */
export async function resolveModel(env: Env, opts: AiCallOptions = {}): Promise<string> {
  if (opts.model) return opts.model;
  return pick(await aiModelsSetting(env), env, await aiKeys(env), opts);
}

/**
 * resolveModel for /api/health: the last read of the setting, read quietly
 * only while nothing has been read since the restart.
 */
export async function resolveModelForHealth(env: Env, keys: AiKeys, opts: AiCallOptions = {}): Promise<string> {
  const s = setting ? setting.value : await aiModelsSetting(env, { quiet: true });
  return pick(s, env, keys, opts);
}

/** Shrinks an image past what the providers take; anything sharp can't read goes as it is. */
export async function fitImage(img: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    const meta = await sharp(img).metadata();
    const edge = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (edge <= MAX_IMAGE_EDGE && img.byteLength <= MAX_IMAGE_BYTES) return img;
    let quality = 90;
    for (;;) {
      const out = await sharp(img)
        .rotate()
        .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality })
        .toBuffer();
      if (out.byteLength <= MAX_IMAGE_BYTES || quality <= 50) {
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
      }
      quality -= 20;
    }
  } catch {
    return img;
  }
}

// AbortSignal.timeout rejects with a DOMException, so match on the name rather
// than the constructor.
function isTimeout(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

export async function aiImageJson(
  env: Env,
  prompt: string,
  imageBytes: ArrayBuffer,
  opts: AiCallOptions = {},
): Promise<Record<string, unknown>> {
  return aiJson(env, prompt, [imageBytes], opts);
}

// Send a prompt with any number of images (none for a text-only ask), get
// back the parsed JSON object. Throws on a missing key, an HTTP error, a
// timeout, or (after one re-ask) unparseable JSON.
export async function aiJson(
  env: Env,
  prompt: string,
  images: readonly ArrayBuffer[],
  opts: AiCallOptions = {},
): Promise<Record<string, unknown>> {
  const ref = await resolveModel(env, opts);
  const { provider: id, model } = parseModelRef(ref);
  const provider = PROVIDERS[id];
  const found = (await aiKeys(env))[id];
  if (!found) {
    throw new Error(`No ${AI_PROVIDER_LABELS[id]} API key for ${ref}: add one on Settings ▸ AI models (or set ${KEY_ENV[id]})`);
  }
  const apiKey: string = found;
  // Only the cost cap reads a price; without one, never wait for a catalogue.
  const price = opts.onUsage ? await priceFor(ref) : undefined;
  const fitted = await Promise.all(images.map(fitImage));

  const attemptMs = opts.timeoutMs ?? OCR_TIMEOUT_MS;
  const deadline = Date.now() + Math.max(OCR_DEADLINE_MS, attemptMs * 2);
  const remaining = () => Math.min(attemptMs, deadline - Date.now());

  async function askOnce(turns: Turn[]): Promise<string> {
    const budget = remaining();
    if (budget <= 0) throw new Error(`${provider.id}: deadline exceeded`);
    let reply: Awaited<ReturnType<typeof provider.complete>>;
    try {
      reply = await provider.complete(apiKey, {
        model,
        turns,
        maxTokens: MAX_TOKENS,
        signal: AbortSignal.timeout(budget),
        webSearch: opts.webSearch,
        wantUsage: !!opts.onUsage,
        price,
      });
    } catch (e) {
      // An empty or refused turn was billed all the same.
      if ((e instanceof EmptyAnswerError || e instanceof RefusalError) && e.usage) opts.onUsage?.(e.usage);
      throw e;
    }
    if (opts.onUsage && reply.usage) opts.onUsage(reply.usage);
    return reply.text;
  }

  // A single slow turn was reaching the field as an error dialog on a phone
  // held over a RAM stick — the human then re-shot the same label and it came
  // back in two seconds. Retry that here instead. A timeout and an empty
  // answer are retried; an HTTP error from the model means the second attempt
  // would fail the same way.
  async function ask(turns: Turn[]): Promise<string> {
    try {
      return await askOnce(turns);
    } catch (e) {
      const retryable = isTimeout(e) || e instanceof EmptyAnswerError;
      if (!retryable || remaining() <= 0) throw e;
      return askOnce(turns);
    }
  }

  const base: Turn = { role: 'user', text: prompt, images: fitted };
  const first = await ask([base]);
  let json = parseModelJson(first);
  if (!json) {
    // Re-send the image so the model retains visual context on the retry turn.
    const second = await ask([
      base,
      { role: 'assistant', text: first },
      { role: 'user', text: 'Your previous reply was not valid JSON. Reply with ONLY the JSON object — no prose, no code fences.' },
    ]);
    json = parseModelJson(second);
  }
  if (!json) throw new Error(`${provider.id}: could not parse JSON from response`);
  return json;
}

export async function aiScan(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
  opts: AiCallOptions = {},
): Promise<ScanResult> {
  const ref = await resolveModel(env, { feature: 'scan', ...opts });
  const json = await aiImageJson(env, PROMPT_BY_CATEGORY[category], imageBytes, { ...opts, model: ref });

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
  // Only the fields the prompt asked for count: eight unknown keys used to
  // lift a reply with no usable RAM field to the floor's maximum.
  const filled = EXPECTED_FIELDS_BY_CATEGORY[category]
    .filter((k) => typeof fields[k] === 'string' && fields[k].trim() !== '').length;
  const expected = EXPECTED_FIELD_COUNT[category];
  const coverageFloor = expected > 0
    ? Math.min(COVERAGE_FLOOR_MAX, (filled / expected) * COVERAGE_FLOOR_MAX)
    : 0;
  const confidence = Math.max(selfRated, coverageFloor);

  return { category, confidence, fields, provider: parseModelRef(ref).provider };
}
