import {afterEach, describe, expect, it, vi} from 'vitest';
import {buildUserMessage, evaluatePost, parseEvaluationContent} from '../src/llm.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const OPTIONS = {
  apiKey: 'test-key',
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

describe('evaluatePost', () => {
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
