import Anthropic from '@anthropic-ai/sdk';
import type {CompletionRequest, CompletionResult} from './index.ts';

/** Room for adaptive thinking plus the verdict; the JSON itself is short. */
const MAX_TOKENS = 4096;

/**
 * Anthropic's structured outputs document `anyOf` but not a `type` array, so
 * `type: ['string', 'null']` is sent as the `anyOf` it means. The other
 * providers keep the schema as written.
 */
export function anthropicSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(anthropicSchema);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = anthropicSchema(v);
  if (Array.isArray(out['type'])) {
    const {type, description, ...rest} = out;
    return {
      ...(description === undefined ? {} : {description}),
      anyOf: (type as unknown[]).map((t) => ({...rest, type: t})),
    };
  }
  return out;
}

export async function completeAnthropic(req: CompletionRequest): Promise<CompletionResult> {
  // Retries belong to the evaluate loop, which backs off per post.
  const client = new Anthropic({apiKey: req.apiKey, maxRetries: 0, timeout: 60_000});
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: req.model,
      max_tokens: MAX_TOKENS,
      system: req.systemPrompt,
      messages: [{role: 'user', content: req.userMessage}],
      // No temperature: current models reject sampling parameters.
      output_config: {effort: 'low', format: {type: 'json_schema', schema: anthropicSchema(req.schema) as Record<string, unknown>}},
    }, {signal: req.signal});
  } catch (e) {
    if (e instanceof Anthropic.APIError && e.status !== undefined) {
      return {kind: 'error', message: `Anthropic HTTP ${e.status}: ${e.message.slice(0, 300)}`};
    }
    return {kind: 'error', message: e instanceof Error ? e.message : String(e)};
  }

  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category ?? 'uncategorised';
    return {kind: 'error', message: `Anthropic refused (${category})`};
  }
  if (message.stop_reason === 'max_tokens') {
    return {kind: 'error', message: 'Anthropic hit max_tokens before finishing the verdict'};
  }

  const content = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (content.trim() === '') {
    return {kind: 'error', message: 'Anthropic returned no text content'};
  }
  return {kind: 'ok', content};
}
