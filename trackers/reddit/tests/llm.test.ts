import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {anthropicSchema, resetEffortSupport} from '../src/llm/anthropic.ts';
import {acceptsTemperature} from '../src/llm/openai.ts';
import {
  buildUserMessage,
  evaluatePost,
  isModelRef,
  parseEvaluationContent,
  parseModelRef,
  RESPONSE_JSON_SCHEMA,
} from '../src/llm/index.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const OPTIONS = {
  keys: {openrouter: 'test-key'},
  model: 'openai/gpt-4o-mini',
  systemPrompt: 'Decide if this is hardware we buy.',
};

const POST = {
  subreddit: 'homelabsales',
  title: '[FS][USA-CO] Dell R730xd, 256GB ECC',
  selftext: 'Selling a Dell R730xd. $650 shipped.',
  author: 'seller123',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

function modelSays(content: string): Response {
  return jsonResponse({choices: [{message: {content}}]});
}

describe('buildUserMessage', () => {
  it('gives the model the subreddit, title and body', () => {
    const message = buildUserMessage(POST);

    expect(message).toContain('r/homelabsales');
    expect(message).toContain(POST.title);
    expect(message).toContain('$650 shipped');
  });

  it('truncates very long bodies to keep the call cheap', () => {
    const message = buildUserMessage({...POST, selftext: 'x'.repeat(10_000)});

    expect(message.length).toBeLessThan(4500);
  });

  it('says so explicitly when a post has no body', () => {
    expect(buildUserMessage({...POST, selftext: ''})).toContain('(no body text)');
  });
});

describe('parseEvaluationContent', () => {
  it('reads a clean JSON verdict', () => {
    const evaluation = parseEvaluationContent(JSON.stringify({
      is_target: true,
      summary: 'Dell R730xd with 256GB ECC.',
      price: '$650 shipped',
      reasoning: 'Server hardware for sale.',
    }));

    expect(evaluation).toMatchObject({
      isTarget: true,
      summary: 'Dell R730xd with 256GB ECC.',
      price: '$650 shipped',
    });
  });

  it('unwraps a verdict a provider wrapped in a markdown fence', () => {
    const evaluation = parseEvaluationContent(
      '```json\n{"is_target": false, "summary": "s", "price": null, "reasoning": "r"}\n```',
    );

    expect(evaluation?.isTarget).toBe(false);
  });

  it('normalises a missing price to null', () => {
    const evaluation = parseEvaluationContent(
      '{"is_target": true, "summary": "s", "price": null, "reasoning": "r"}',
    );

    expect(evaluation?.price).toBeNull();
  });

  it('treats an empty price string as no price', () => {
    const evaluation = parseEvaluationContent(
      '{"is_target": true, "summary": "s", "price": "", "reasoning": "r"}',
    );

    expect(evaluation?.price).toBeNull();
  });

  it('rejects a response with no verdict in it', () => {
    expect(parseEvaluationContent('I think this is a good deal!')).toBeNull();
    expect(parseEvaluationContent('{"summary": "s"}')).toBeNull();
    expect(parseEvaluationContent('')).toBeNull();
  });
});

describe('evaluatePost via OpenRouter', () => {
  it('asks for structured output from the configured model', async () => {
    const spy = vi.fn().mockResolvedValue(modelSays(
      '{"is_target": true, "summary": "s", "price": null, "reasoning": "r"}',
    ));
    vi.stubGlobal('fetch', spy);

    await evaluatePost(POST, OPTIONS);

    const init = spy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages[0]).toEqual({role: 'system', content: OPTIONS.systemPrompt});
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
  });

  it('asks for the reasoning before the verdict, so the model counts before it commits', async () => {
    const spy = vi.fn().mockResolvedValue(modelSays(
      '{"reasoning": "r", "is_target": false, "summary": "s", "price": null}',
    ));
    vi.stubGlobal('fetch', spy);

    await evaluatePost(POST, OPTIONS);

    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    const schema = body.response_format.json_schema.schema;
    expect(Object.keys(schema.properties)).toEqual(['reasoning', 'is_target', 'summary', 'price']);
    expect(schema.required).toEqual(['reasoning', 'is_target', 'summary', 'price']);
  });

  it('returns the verdict on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(modelSays(
      '{"is_target": true, "summary": "Dell R730xd", "price": "$650", "reasoning": "r"}',
    )));

    const result = await evaluatePost(POST, OPTIONS);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.evaluation.isTarget).toBe(true);
    expect(result.evaluation.price).toBe('$650');
  });

  it('reports an HTTP failure instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rate limited', {status: 429})));

    const result = await evaluatePost(POST, OPTIONS);

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('429');
  });

  it('reports an error object returned with HTTP 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse({error: {message: 'upstream provider failed'}}),
    ));

    const result = await evaluatePost(POST, OPTIONS);

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('upstream provider failed');
  });

  it('reports a response with no usable verdict', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(modelSays('sure, looks good to me')));

    expect((await evaluatePost(POST, OPTIONS)).kind).toBe('error');
  });

  it('reports an empty completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({choices: []})));

    expect((await evaluatePost(POST, OPTIONS)).kind).toBe('error');
  });

  it('reports a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ETIMEDOUT')));

    const result = await evaluatePost(POST, OPTIONS);

    expect(result).toEqual({kind: 'error', message: 'ETIMEDOUT'});
  });
});

const VERDICT = '{"reasoning": "r", "is_target": true, "summary": "s", "price": "$650"}';

describe('parseModelRef', () => {
  it('reads a bare id as OpenRouter, so stored values keep working', () => {
    expect(parseModelRef('google/gemini-2.5-flash'))
      .toEqual({provider: 'openrouter', model: 'google/gemini-2.5-flash'});
    expect(parseModelRef('openai/gpt-5.6-luna'))
      .toEqual({provider: 'openrouter', model: 'openai/gpt-5.6-luna'});
    expect(parseModelRef('x/y:online')).toEqual({provider: 'openrouter', model: 'x/y:online'});
  });

  it('reads a provider prefix', () => {
    expect(parseModelRef('anthropic:claude-sonnet-5-5'))
      .toEqual({provider: 'anthropic', model: 'claude-sonnet-5-5'});
    expect(parseModelRef('openai:gpt-6-luna')).toEqual({provider: 'openai', model: 'gpt-6-luna'});
    expect(parseModelRef('openrouter:x/y:online'))
      .toEqual({provider: 'openrouter', model: 'x/y:online'});
  });

  it('only counts a known prefix at the start', () => {
    expect(parseModelRef('mistral:large').provider).toBe('openrouter');
    expect(parseModelRef(' anthropic:claude').provider).toBe('openrouter');
  });
});

describe('isModelRef', () => {
  it('accepts bare and prefixed OpenRouter ids', () => {
    expect(isModelRef('google/gemini-2.5-flash')).toBe(true);
    expect(isModelRef('x/y:online')).toBe(true);
    expect(isModelRef('openrouter:google/gemini-2.5-flash')).toBe(true);
  });

  it('accepts direct provider models', () => {
    expect(isModelRef('anthropic:claude-sonnet-5-5')).toBe(true);
    expect(isModelRef('openai:gpt-6-luna')).toBe(true);
    expect(isModelRef('openai:gpt-5.6')).toBe(true);
  });

  it('rejects malformed refs', () => {
    expect(isModelRef('')).toBe(false);
    expect(isModelRef('gpt-4o-mini')).toBe(false);
    expect(isModelRef('anthropic:')).toBe(false);
    expect(isModelRef('anthropic:claude/sonnet')).toBe(false);
    expect(isModelRef('openai:gpt 6')).toBe(false);
    expect(isModelRef('openrouter:gpt-4o-mini')).toBe(false);
  });
});

describe('evaluatePost provider routing', () => {
  it('fails without a request when the provider has no key, so the loop retries', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    expect(await evaluatePost(POST, {...OPTIONS, model: 'anthropic:claude-sonnet-5-5'}))
      .toEqual({kind: 'error', message: 'ANTHROPIC_API_KEY is not set'});
    expect(await evaluatePost(POST, {...OPTIONS, model: 'openai:gpt-6-luna'}))
      .toEqual({kind: 'error', message: 'OPENAI_API_KEY is not set'});
    expect(await evaluatePost(POST, {...OPTIONS, keys: {openrouter: ''}}))
      .toEqual({kind: 'error', message: 'OPENROUTER_API_KEY is not set'});
    expect(spy).not.toHaveBeenCalled();
  });

  it('never puts the key in an error message', async () => {
    const key = 'sk-or-v1-SECRETSECRET-9z9z';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new TypeError(`Headers.append: "Bearer ${key}\r\n" is an invalid header value.`),
    ));

    const result = await evaluatePost(POST, {...OPTIONS, keys: {openrouter: key}});

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).not.toContain(key);
    expect(result.message).toContain('9z9z');
  });

  it('sends an openrouter: ref to OpenRouter with the prefix stripped', async () => {
    const spy = vi.fn().mockResolvedValue(modelSays(VERDICT));
    vi.stubGlobal('fetch', spy);

    await evaluatePost(POST, {...OPTIONS, model: 'openrouter:openai/gpt-4o-mini'});

    expect(spy.mock.calls[0]![0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('openai/gpt-4o-mini');
  });

  it('keeps the OpenRouter request exactly as before', async () => {
    const spy = vi.fn().mockResolvedValue(modelSays(VERDICT));
    vi.stubGlobal('fetch', spy);

    await evaluatePost(POST, OPTIONS);

    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://recycleservers.com',
      'X-Title': 'Recycle Servers Reddit Tracker',
    });
    // String equality, so key order is pinned too.
    expect(init.body).toBe(JSON.stringify({
      model: 'openai/gpt-4o-mini',
      temperature: 0,
      messages: [
        {role: 'system', content: OPTIONS.systemPrompt},
        {role: 'user', content: buildUserMessage(POST)},
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {name: 'post_evaluation', strict: true, schema: RESPONSE_JSON_SCHEMA},
      },
    }));
  });
});

function anthropicSays(
  text: string,
  stop: {stop_reason: string; stop_details?: unknown} = {stop_reason: 'end_turn'},
): Response {
  return jsonResponse({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [{type: 'thinking', thinking: '', signature: 'sig'}, {type: 'text', text}],
    stop_details: null,
    stop_sequence: null,
    usage: {input_tokens: 1, output_tokens: 1},
    ...stop,
  });
}

/** A Models API entry; `effort` null leaves capabilities out entirely. */
function modelInfo(id: string, effort: boolean | null): Response {
  const yes = {supported: true};
  const flag = {supported: Boolean(effort)};
  return jsonResponse({
    type: 'model',
    id,
    display_name: id,
    created_at: '2026-01-01T00:00:00Z',
    capabilities: effort === null ? null : {
      effort: {supported: effort, low: flag, medium: flag, high: flag, max: flag, xhigh: null},
      structured_outputs: yes,
    },
  });
}

/**
 * Stubs the Anthropic API: the Models API answers `models` (or 404 when the
 * id is missing from it), the Messages API answers `message`.
 */
function stubAnthropic(
  message: () => Response,
  models: Record<string, boolean | null> = {'claude-sonnet-5-5': true},
) {
  const spy = vi.fn().mockImplementation(async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    if (path.startsWith('/v1/models/')) {
      const id = decodeURIComponent(path.slice('/v1/models/'.length));
      if (!(id in models)) {
        return jsonResponse({type: 'error', error: {type: 'not_found_error', message: 'no'}}, 404);
      }
      return modelInfo(id, models[id]!);
    }
    return message();
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function messagesCall(spy: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = spy.mock.calls.find(([url]) => String(url).endsWith('/v1/messages'));
  return call as [string, RequestInit];
}

describe('evaluatePost via Anthropic', () => {
  const ANTHROPIC = {
    ...OPTIONS,
    keys: {anthropic: 'ant-key'},
    model: 'anthropic:claude-sonnet-5-5',
  };

  beforeEach(() => {
    resetEffortSupport();
  });

  it('sends the shared schema as output_config.format, without temperature', async () => {
    const spy = stubAnthropic(() => anthropicSays(VERDICT));

    await evaluatePost(POST, ANTHROPIC);

    const [url, init] = messagesCall(spy);
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer ant-key');
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('temperature');
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.system).toBe(OPTIONS.systemPrompt);
    expect(body.messages).toEqual([{role: 'user', content: buildUserMessage(POST)}]);
    expect(body.output_config).toEqual({
      effort: 'low',
      format: {type: 'json_schema', schema: anthropicSchema(RESPONSE_JSON_SCHEMA)},
    });
    // The one type array in the schema goes out as the anyOf Anthropic documents.
    expect(body.output_config.format.schema.properties.price).toEqual({
      description: RESPONSE_JSON_SCHEMA.properties.price.description,
      anyOf: [{type: 'string'}, {type: 'null'}],
    });
    expect(body.output_config.format.schema.required).toEqual(RESPONSE_JSON_SCHEMA.required);
  });

  it('sends no effort to a model the Models API says lacks it', async () => {
    const spy = stubAnthropic(() => anthropicSays(VERDICT), {'claude-haiku-4-5': false});

    await evaluatePost(POST, {...ANTHROPIC, model: 'anthropic:claude-haiku-4-5'});

    const body = JSON.parse(messagesCall(spy)[1].body as string);
    expect(body.output_config).not.toHaveProperty('effort');
    expect(body.output_config.format.type).toBe('json_schema');
  });

  it('asks the Models API once per model', async () => {
    const spy = stubAnthropic(() => anthropicSays(VERDICT));

    await evaluatePost(POST, ANTHROPIC);
    await evaluatePost(POST, ANTHROPIC);

    const lookups = spy.mock.calls.filter(([url]) => String(url).includes('/v1/models/'));
    expect(lookups).toHaveLength(1);
  });

  it('falls back to the known pre-effort models when the Models API cannot say', async () => {
    // Neither id is in the stubbed Models API, so both lookups 404.
    const spy = stubAnthropic(() => anthropicSays(VERDICT), {});

    await evaluatePost(POST, {...ANTHROPIC, model: 'anthropic:claude-haiku-4-5-20251001'});
    await evaluatePost(POST, {...ANTHROPIC, model: 'anthropic:claude-opus-4-5'});

    const bodies = spy.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/messages'))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies.map((b) => b.output_config.effort)).toEqual([undefined, 'low']);
  });

  it('reads the verdict from the text blocks', async () => {
    stubAnthropic(() => anthropicSays(VERDICT));

    const result = await evaluatePost(POST, ANTHROPIC);

    expect(result).toMatchObject({kind: 'ok', evaluation: {isTarget: true, price: '$650'}});
  });

  it('reports a refusal as an error', async () => {
    stubAnthropic(() => anthropicSays('', {
      stop_reason: 'refusal',
      stop_details: {type: 'refusal', category: 'cyber', explanation: null},
    }));

    const result = await evaluatePost(POST, ANTHROPIC);

    expect(result).toEqual({kind: 'error', message: 'Anthropic refused (cyber)'});
  });

  it('reports an HTTP failure with its status instead of throwing', async () => {
    stubAnthropic(() => jsonResponse(
      {type: 'error', error: {type: 'rate_limit_error', message: 'slow down'}},
      429,
    ));

    const result = await evaluatePost(POST, ANTHROPIC);

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toMatch(/^Anthropic HTTP 429/);
  });
});

function openaiSays(content: unknown[], extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    model: 'gpt-6-luna',
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [{type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content}],
    ...extra,
  });
}

describe('evaluatePost via OpenAI', () => {
  const OPENAI = {...OPTIONS, keys: {openai: 'oa-key'}, model: 'openai:gpt-6-luna'};

  it('sends temperature 0 to a chat model that takes it', async () => {
    const spy = vi.fn().mockResolvedValue(
      openaiSays([{type: 'output_text', text: VERDICT, annotations: []}]),
    );
    vi.stubGlobal('fetch', spy);

    await evaluatePost(POST, {...OPENAI, model: 'openai:gpt-4.1-mini'});

    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.temperature).toBe(0);
  });

  it('knows which models take temperature', () => {
    expect(['gpt-4o-mini', 'gpt-4.1', 'gpt-3.5-turbo', 'chatgpt-4o-latest']
      .every(acceptsTemperature)).toBe(true);
    expect(['gpt-6-luna', 'gpt-5.6', 'o3', 'o4-mini', 'gpt-5-mini']
      .some(acceptsTemperature)).toBe(false);
  });

  it('sends the shared schema through the Responses API, without temperature for a reasoning model', async () => {
    const spy = vi.fn().mockResolvedValue(
      openaiSays([{type: 'output_text', text: VERDICT, annotations: []}]),
    );
    vi.stubGlobal('fetch', spy);

    const result = await evaluatePost(POST, OPENAI);

    expect(result).toMatchObject({kind: 'ok', evaluation: {isTarget: true}});
    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer oa-key');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'gpt-6-luna',
      instructions: OPTIONS.systemPrompt,
      input: buildUserMessage(POST),
      text: {
        format: {
          type: 'json_schema',
          name: 'post_evaluation',
          strict: true,
          schema: RESPONSE_JSON_SCHEMA,
        },
      },
    });
  });

  it('reports a refusal as an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openaiSays([{type: 'refusal', refusal: 'cannot help'}]),
    ));

    const result = await evaluatePost(POST, OPENAI);

    expect(result).toEqual({kind: 'error', message: 'OpenAI refused: cannot help'});
  });

  it('reports an incomplete response as an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openaiSays([], {
      status: 'incomplete',
      incomplete_details: {reason: 'max_output_tokens'},
    })));

    const result = await evaluatePost(POST, OPENAI);

    expect(result).toEqual({
      kind: 'error',
      message: 'OpenAI response incomplete (max_output_tokens)',
    });
  });
});
