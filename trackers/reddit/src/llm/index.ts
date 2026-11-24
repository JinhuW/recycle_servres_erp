// Decides whether a post is something we want to buy, and writes the one-line
// summary that goes into the Telegram alert. One model call does both; the
// model ref picks the provider (ref.ts).

import {completeAnthropic} from './anthropic.ts';
import {completeOpenAI} from './openai.ts';
import {completeOpenRouter} from './openrouter.ts';
import {parseModelRef, type Provider} from './ref.ts';

export {isModelRef, parseModelRef, type ModelRef, type Provider} from './ref.ts';

export interface Evaluation {
  isTarget: boolean;
  summary: string;
  price: string | null;
  reasoning: string;
  raw: unknown;
}

export type EvaluationResult =
  | {kind: 'ok'; evaluation: Evaluation}
  | {kind: 'error'; message: string};

export interface EvaluationInput {
  subreddit: string;
  title: string;
  selftext: string;
  author: string | null;
}

/** API keys by provider; an empty or missing key means that provider is off. */
export type LlmKeys = Partial<Record<Provider, string>>;

/** What every provider adapter takes. */
export interface CompletionRequest {
  apiKey: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  schemaName: string;
  schema: typeof RESPONSE_JSON_SCHEMA;
  signal: AbortSignal;
}

/** The model's raw text, or why there is none. */
export type CompletionResult =
  | {kind: 'ok'; content: string}
  | {kind: 'error'; message: string};

const REQUEST_TIMEOUT_MS = 60_000;
/** Keeps the prompt cheap; sale posts put the essentials up top. */
const MAX_BODY_CHARS = 4000;

/**
 * Names the response schema below; part of every prompt version's identity
 * (prompts.ts), because the same wording judges differently under another
 * schema.
 */
export const RESPONSE_SCHEMA_ID = 'reasoning-first';

const RESPONSE_SCHEMA_NAME = 'post_evaluation';

// Reasoning comes first on purpose. Structured output writes the fields in
// schema order, and with the verdict first the model committed before it
// counted: "4 target items … does not meet the minimum of 7", is_target true.
// Measured on 100 prod posts in
// docs/prompt-evaluations/2026-10-19-candidate-1-offline.md.
// Every provider gets this same object, so RESPONSE_SCHEMA_ID stays true.
export const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reasoning', 'is_target', 'summary', 'price'],
  properties: {
    reasoning: {type: 'string', description: 'Brief justification for the verdict.'},
    is_target: {
      type: 'boolean',
      description: 'True only if this is a for-sale listing of hardware we buy.',
    },
    summary: {
      type: 'string',
      description: 'One or two sentences describing the item, for a buyer alert.',
    },
    price: {
      type: ['string', 'null'],
      description: 'Asking price exactly as written, or null if not stated.',
    },
  },
} as const;

const ADAPTERS: Record<Provider, (req: CompletionRequest) => Promise<CompletionResult>> = {
  openrouter: completeOpenRouter,
  anthropic: completeAnthropic,
  openai: completeOpenAI,
};

function redactKey(message: string, apiKey: string): string {
  return message.split(apiKey).join(`[key …${apiKey.slice(-4)}]`);
}

export function buildUserMessage(post: EvaluationInput): string {
  const body = post.selftext.slice(0, MAX_BODY_CHARS);
  return [
    `Subreddit: r/${post.subreddit}`,
    `Author: ${post.author ?? 'unknown'}`,
    `Title: ${post.title}`,
    '',
    'Body:',
    body || '(no body text)',
  ].join('\n');
}

/**
 * Pulls JSON out of a model response. Providers that ignore the response
 * format tend to wrap the object in a markdown fence, so unwrap before
 * giving up.
 */
export function parseEvaluationContent(content: string): Evaluation | null {
  const candidates = [content.trim()];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    const record = parsed as Record<string, unknown>;
    if (typeof record['is_target'] !== 'boolean') continue;

    return {
      isTarget: record['is_target'],
      summary: typeof record['summary'] === 'string' ? record['summary'] : '',
      price: typeof record['price'] === 'string' && record['price'].length > 0
        ? record['price']
        : null,
      reasoning: typeof record['reasoning'] === 'string' ? record['reasoning'] : '',
      raw: parsed,
    };
  }

  return null;
}

/**
 * Evaluates one post. Never throws: a failure comes back typed so the loop
 * can retry it with backoff rather than losing the post.
 */
export async function evaluatePost(
  post: EvaluationInput,
  options: {keys: LlmKeys; model: string; systemPrompt: string},
): Promise<EvaluationResult> {
  const {provider, model} = parseModelRef(options.model);
  const apiKey = options.keys[provider];
  if (!apiKey) {
    return {kind: 'error', message: `no ${provider} API key: paste one on the ERP's Settings ▸ AI models`};
  }

  let result: CompletionResult;
  try {
    result = await ADAPTERS[provider]({
      apiKey,
      model,
      systemPrompt: options.systemPrompt,
      userMessage: buildUserMessage(post),
      schemaName: RESPONSE_SCHEMA_NAME,
      schema: RESPONSE_JSON_SCHEMA,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    result = {kind: 'error', message: e instanceof Error ? e.message : String(e)};
  }
  // Error messages are logged and reach the ops group. Some quote the request
  // (fetch names a header value it rejects), so the key never rides along.
  if (result.kind === 'error') return {kind: 'error', message: redactKey(result.message, apiKey)};

  const evaluation = parseEvaluationContent(result.content);
  if (!evaluation) {
    return {kind: 'error', message: `could not parse verdict from: ${result.content.slice(0, 200)}`};
  }
  return {kind: 'ok', evaluation};
}
