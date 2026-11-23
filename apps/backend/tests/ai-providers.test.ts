import { describe, it, expect, afterEach, vi } from 'vitest';
import { isModelRef, parseModelRef } from '@recycle-erp/shared';
import { aiImageJson, aiJson, aiScan } from '../src/ai/llm';
import { pickProvider } from '../src/ai/index';
import type { Env } from '../src/types';

describe('pickProvider with several providers', () => {
  it('stub when no provider key is set at all', async () => {
    expect(await pickProvider({ AI_MODEL: 'anthropic:claude-sonnet-5-5' } as Env)).toBe('stub');
  });
  it("the env default's provider when its key is set", async () => {
    expect(await pickProvider({ ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o', AI_MODEL: 'anthropic:claude-sonnet-5-5' } as Env))
      .toBe('anthropic');
  });
  it('whichever provider has a key when the default has none', async () => {
    expect(await pickProvider({ OPENAI_API_KEY: 'k' } as Env)).toBe('openai');
  });
});

describe('model refs', () => {
  it('reads a bare id as OpenRouter, so saved settings keep their meaning', async () => {
    expect(parseModelRef('openai/gpt-6-luna')).toEqual({ provider: 'openrouter', model: 'openai/gpt-6-luna' });
    expect(parseModelRef('google/gemini-2.5-flash:online'))
      .toEqual({ provider: 'openrouter', model: 'google/gemini-2.5-flash:online' });
    expect(parseModelRef('anthropic:claude-sonnet-5-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(parseModelRef('openai:gpt-6-luna')).toEqual({ provider: 'openai', model: 'gpt-6-luna' });
  });
  it('validates each provider by its own id shape', async () => {
    expect(isModelRef('openai/gpt-6-luna')).toBe(true);
    expect(isModelRef('openrouter:openai/gpt-6-luna')).toBe(true);
    expect(isModelRef('anthropic:claude-sonnet-5-5')).toBe(true);
    expect(isModelRef('anthropic:claude/sonnet')).toBe(false);
    expect(isModelRef('gpt-4o')).toBe(false);
    expect(isModelRef('not a model')).toBe(false);
  });
});

describe('the Anthropic provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer;
  const env = { ANTHROPIC_API_KEY: 'a', AI_MODEL: 'anthropic:claude-sonnet-5-5' } as Env;
  const message = (content: unknown[], stop = 'end_turn', usage: unknown = { input_tokens: 1000, output_tokens: 100 }) =>
    new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
      content, stop_reason: stop, stop_sequence: null, usage,
    }), { status: 200, headers: { 'content-type': 'application/json' } });

  function capture(...responses: Response[]) {
    const fn = vi.fn(async () => responses.shift()!);
    vi.stubGlobal('fetch', fn);
    return {
      urls: () => fn.mock.calls.map(c => String((c as unknown as [string])[0])),
      bodies: () => fn.mock.calls.map(c => JSON.parse((c as unknown as [string, RequestInit])[1].body as string)),
    };
  }

  it('sends the image as base64, no temperature, low effort', async () => {
    const { urls, bodies } = capture(message([{ type: 'text', text: '{"brand":"Samsung","_confidence":0.9}' }]));
    const r = await aiScan(env, 'RAM', png);
    expect(r.provider).toBe('anthropic');
    expect(r.fields).toEqual({ brand: 'Samsung' });
    expect(urls()[0]).toBe('https://api.anthropic.com/v1/messages');
    const [body] = bodies();
    expect(body.model).toBe('claude-sonnet-5-5');
    expect('temperature' in body).toBe(false);
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.messages[0].content[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect(body.messages[0].content[1].type).toBe('text');
    expect('tools' in body).toBe(false);
  });

  it('adds the web_search tool and reports cost for a lookup', async () => {
    const { bodies } = capture(message(
      [{ type: 'text', text: '{"specs":{}}' }], 'end_turn',
      { input_tokens: 1_000_000, output_tokens: 0, server_tool_use: { web_search_requests: 2 } },
    ));
    const usage: Array<{ costUsd: number }> = [];
    await aiJson(env, 'look it up', [], { webSearch: true, onUsage: (u) => usage.push(u) });
    expect(bodies()[0].tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
    // $2 per million input tokens on Sonnet 5.5, plus two searches at a cent.
    expect(usage[0]!.costUsd).toBeCloseTo(2.02);
  });

  it('carries on after a pause_turn', async () => {
    const { bodies } = capture(
      message([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }], 'pause_turn'),
      message([{ type: 'text', text: '{"specs":{"a":"1"}}' }]),
    );
    expect(await aiJson(env, 'look it up', [], { webSearch: true })).toEqual({ specs: { a: '1' } });
    expect(bodies()).toHaveLength(2);
    expect(bodies()[1].messages[1].role).toBe('assistant');
  });

  it('turns a refusal into an error', async () => {
    capture(message([], 'refusal'));
    await expect(aiImageJson(env, 'p', png)).rejects.toThrow(/declined/);
  });

  it('refuses to call without its key', async () => {
    await expect(aiImageJson({ AI_MODEL: 'anthropic:claude-sonnet-5-5', OPENROUTER_API_KEY: 'o' } as Env, 'p', png))
      .rejects.toThrow(/No Anthropic \(Claude\) API key.*ANTHROPIC_API_KEY/);
  });

  it('a per-call model wins over the env default', async () => {
    const { urls } = capture(message([{ type: 'text', text: '{"a":1}' }]));
    await aiImageJson({ ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o' } as Env, 'p', png,
      { model: 'anthropic:claude-haiku-5-5' });
    expect(urls()[0]).toContain('api.anthropic.com');
  });
});

describe('the OpenAI provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
  const env = { OPENAI_API_KEY: 'k', AI_MODEL: 'openai:gpt-6-luna' } as Env;
  const response = (text: string) => new Response(JSON.stringify({
    id: 'resp_1', object: 'response', created_at: 0, status: 'completed', model: 'gpt-6-luna',
    output: [{
      type: 'message', id: 'm', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }],
    usage: {
      input_tokens: 10, output_tokens: 5, total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('uses the Responses API with a high-detail image and JSON mode', async () => {
    const fn = vi.fn(async () => response('{"serial":"ABC123"}'));
    vi.stubGlobal('fetch', fn);
    expect(await aiImageJson(env, 'read the serial', jpg)).toEqual({ serial: 'ABC123' });
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-6-luna');
    expect(body.text).toEqual({ format: { type: 'json_object' } });
    expect(body.input[0].content[1]).toMatchObject({ type: 'input_image', detail: 'high' });
    expect(body.input[0].content[1].image_url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('swaps JSON mode for the web_search tool on a lookup', async () => {
    const fn = vi.fn(async () => response('{"specs":{}}'));
    vi.stubGlobal('fetch', fn);
    await aiJson(env, 'look it up', [], { webSearch: true });
    const body = JSON.parse((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect('text' in body).toBe(false);
  });
});
