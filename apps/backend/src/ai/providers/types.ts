import type { AiProviderId } from '@recycle-erp/shared';
import type { Env } from '../../types';

export type AiUsage = { promptTokens: number; completionTokens: number; costUsd: number };

/** One turn of the conversation, provider-neutral; images ride on user turns. */
export type Turn = { role: 'user' | 'assistant'; text: string; images?: readonly ArrayBuffer[] };

export type CompleteRequest = {
  model: string;
  turns: Turn[];
  maxTokens: number;
  signal: AbortSignal;
  /** Let the model read the web before it answers (PO review part lookups). */
  webSearch?: boolean;
  wantUsage?: boolean;
  /** USD per million tokens (input, output), for providers whose API reports no cost. */
  price?: [number, number];
};

/** One entry of the model picker's catalogue. `id` is a full model ref. */
export interface AiModel {
  id: string;
  provider: AiProviderId;
  name: string;
  contextLength: number | null;
  /** USD per million tokens; null when unknown, or for routers. */
  promptPerM: number | null;
  completionPerM: number | null;
  /** Honours a strict JSON schema, which the Reddit tracker's evaluator sends. */
  structuredOutputs: boolean;
  inputModalities: string[];
  outputModalities: string[];
}

export interface LlmProvider {
  id: AiProviderId;
  /** The env var that turns it on, for error messages. */
  keyName: string;
  configured(env: Env): boolean;
  /** One model turn. Throws on HTTP errors; EmptyAnswerError on no content. */
  complete(env: Env, req: CompleteRequest): Promise<{ text: string; usage?: AiUsage }>;
  /** Its models for the picker, ids already prefixed. */
  listModels(env: Env): Promise<AiModel[]>;
}

// A reply with no content at all, e.g. a reasoning model that spent its
// budget thinking. Worth one more ask, like a timeout.
export class EmptyAnswerError extends Error {
  constructor(provider: string) {
    super(`${provider}: no content in response`);
    this.name = 'EmptyAnswerError';
  }
}

export function sniffMime(b: Uint8Array): 'image/png' | 'image/webp' | 'image/jpeg' {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

export function toBase64(img: ArrayBuffer): { mime: ReturnType<typeof sniffMime>; data: string } {
  const bytes = new Uint8Array(img);
  return { mime: sniffMime(bytes), data: Buffer.from(bytes).toString('base64') };
}
