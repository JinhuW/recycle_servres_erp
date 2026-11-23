import type {CompletionRequest, CompletionResult} from './index.ts';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export async function completeOpenRouter(req: CompletionRequest): Promise<CompletionResult> {
  let response: Response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter attributes traffic with these; they are not auth.
        'HTTP-Referer': 'https://recycleservers.com',
        'X-Title': 'Recycle Servers Reddit Tracker',
      },
      body: JSON.stringify({
        model: req.model,
        temperature: 0,
        messages: [
          {role: 'system', content: req.systemPrompt},
          {role: 'user', content: req.userMessage},
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {name: req.schemaName, strict: true, schema: req.schema},
        },
      }),
      signal: req.signal,
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
  return {kind: 'ok', content};
}
