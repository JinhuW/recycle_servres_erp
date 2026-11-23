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

// Models from before the effort parameter, which answer 400 to it. Used only
// when the Models API can't say: no model released later lacks effort.
const NO_EFFORT_MODEL =
  /^claude-(?:instant|2|3|opus-4-(?:0|1|2025)|sonnet-4-(?:0|5|2025)|haiku-4-5)/;

/** Effort support by model id, from the Models API; it never changes. */
const effortSupport = new Map<string, boolean>();

/** Forgets what the Models API said, so tests start from a clean slate. */
export function resetEffortSupport(): void {
  effortSupport.clear();
}

/**
 * Whether a model takes `output_config.effort: 'low'`. Asks the Models API
 * once per model and process; a failed lookup falls back to the list above
 * and is asked again next time.
 */
async function supportsLowEffort(
  client: Anthropic,
  model: string,
  signal: AbortSignal,
): Promise<boolean> {
  const known = effortSupport.get(model);
  if (known !== undefined) return known;
  try {
    const info = await client.models.retrieve(model, undefined, {signal});
    const effort = info.capabilities?.effort;
    if (effort) {
      const supported = effort.supported && effort.low.supported;
      effortSupport.set(model, supported);
      return supported;
    }
  } catch {
    // Not worth failing the verdict over; the messages call reports real faults.
  }
  return !NO_EFFORT_MODEL.test(model);
}

export async function completeAnthropic(req: CompletionRequest): Promise<CompletionResult> {
  // Retries belong to the evaluate loop, which backs off per post.
  const client = new Anthropic({apiKey: req.apiKey, maxRetries: 0, timeout: 60_000});
  let message: Anthropic.Message;
  try {
    // Low effort keeps the bill down where the model has the setting.
    const effort = await supportsLowEffort(client, req.model, req.signal)
      ? {effort: 'low' as const}
      : {};
    message = await client.messages.create({
      model: req.model,
      max_tokens: MAX_TOKENS,
      system: req.systemPrompt,
      messages: [{role: 'user', content: req.userMessage}],
      // No temperature: current models reject sampling parameters.
      output_config: {
        ...effort,
        format: {type: 'json_schema', schema: anthropicSchema(req.schema) as Record<string, unknown>},
      },
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
