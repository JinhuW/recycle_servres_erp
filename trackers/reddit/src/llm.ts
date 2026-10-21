// Decides whether a post is something we want to buy, and writes the one-line
// summary that goes into the Telegram alert. One OpenRouter call does both.

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

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60_000;
/** Keeps the prompt cheap; sale posts put the essentials up top. */
const MAX_BODY_CHARS = 4000;

/**
 * Names the response schema below; part of every prompt version's identity
 * (prompts.ts), because the same wording judges differently under another
 * schema.
 */
export const RESPONSE_SCHEMA_ID = 'reasoning-first';

// Reasoning comes first on purpose. Structured output writes the fields in
// schema order, and with the verdict first the model committed before it
// counted: "4 target items … does not meet the minimum of 7", is_target true.
// Measured on 100 prod posts in
// docs/prompt-evaluations/2026-10-19-candidate-1-offline.md.
const RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'post_evaluation',
    strict: true,
    schema: {
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
    },
  },
} as const;

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
  options: {apiKey: string; model: string; systemPrompt: string},
): Promise<EvaluationResult> {
  let response: Response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter attributes traffic with these; they are not auth.
        'HTTP-Referer': 'https://recycleservers.com',
        'X-Title': 'Recycle Servers Reddit Tracker',
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        messages: [
          {role: 'system', content: options.systemPrompt},
          {role: 'user', content: buildUserMessage(post)},
        ],
        response_format: RESPONSE_SCHEMA,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return {kind: 'error', message: e instanceof Error ? e.message : String(e)};
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    return {kind: 'error', message: `OpenRouter HTTP ${response.status}: ${detail}`};
  }

  let payload: {choices?: Array<{message?: {content?: string}}>; error?: {message?: string}};
  try {
    payload = await response.json() as typeof payload;
  } catch (e) {
    return {kind: 'error', message: `unparseable OpenRouter response: ${String(e)}`};
  }

  // OpenRouter can return HTTP 200 with an error object when an upstream
  // provider fails mid-stream.
  if (payload.error) {
    return {kind: 'error', message: `OpenRouter error: ${payload.error.message ?? 'unknown'}`};
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    return {kind: 'error', message: 'OpenRouter returned no message content'};
  }

  const evaluation = parseEvaluationContent(content);
  if (!evaluation) {
    return {kind: 'error', message: `could not parse verdict from: ${content.slice(0, 200)}`};
  }

  return {kind: 'ok', evaluation};
}
