import OpenAI from 'openai';
import type {CompletionRequest, CompletionResult} from './index.ts';

export async function completeOpenAI(req: CompletionRequest): Promise<CompletionResult> {
  // Retries belong to the evaluate loop, which backs off per post.
  const client = new OpenAI({apiKey: req.apiKey, maxRetries: 0, timeout: 60_000});
  let response: OpenAI.Responses.Response;
  try {
    response = await client.responses.create({
      model: req.model,
      instructions: req.systemPrompt,
      input: req.userMessage,
      text: {format: {type: 'json_schema', name: req.schemaName, strict: true, schema: req.schema}},
    }, {signal: req.signal});
  } catch (e) {
    if (e instanceof OpenAI.APIError && e.status !== undefined) {
      return {kind: 'error', message: `OpenAI HTTP ${e.status}: ${e.message.slice(0, 300)}`};
    }
    return {kind: 'error', message: e instanceof Error ? e.message : String(e)};
  }

  if (response.error) {
    return {kind: 'error', message: `OpenAI error: ${response.error.message}`};
  }
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown';
    return {kind: 'error', message: `OpenAI response incomplete (${reason})`};
  }
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'refusal') {
        return {kind: 'error', message: `OpenAI refused: ${part.refusal.slice(0, 200)}`};
      }
    }
  }

  const content = response.output_text;
  if (typeof content !== 'string' || content.trim() === '') {
    return {kind: 'error', message: 'OpenAI returned no text content'};
  }
  return {kind: 'ok', content};
}
