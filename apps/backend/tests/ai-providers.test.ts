import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import sharp from 'sharp';
import { isModelRef, parseModelRef } from '@recycle-erp/shared';
import { aiImageJson, aiJson, aiScan } from '../src/ai/llm';
import { describeOcr, pickProvider } from '../src/ai/index';
import { _resetCapsForTests } from '../src/ai/providers/anthropic';
import { minimalReasoning } from '../src/ai/providers/openai';
import { fallbackModel, invalidateAiModelsSetting, resolveModel } from '../src/ai/llm';
import type { Env } from '../src/types';
import { getTestDb, resetDb } from './helpers/db';
import { testEnv } from './helpers/app';
import { seedAiKey } from './helpers/aiKeys';

const seed = (provider: 'openrouter' | 'anthropic' | 'openai', key = 'k') =>
  seedAiKey(getTestDb(), testEnv, provider, key);

async function saveDefaultModel(ref: string): Promise<void> {
  await getTestDb()`
    INSERT INTO workspace_settings (key, value) VALUES ('ai_models', ${getTestDb().json({ default: ref })})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  invalidateAiModelsSetting();
}

describe('pickProvider with several providers', () => {
  beforeEach(resetDb);
  it('stub when no provider key is saved, whatever the env says', async () => {
    const env = { ...testEnv, ANTHROPIC_API_KEY: 'a', AI_MODEL: 'anthropic:claude-sonnet-5-5' } as Env;
    expect(await pickProvider(env)).toBe('stub');
  });
  it('whichever provider has a key', async () => {
    await seed('openai');
    expect(await pickProvider(testEnv)).toBe('openai');
  });
});

// With no model chosen, calls used to go to the OpenRouter default whatever
// keys were set, while /api/health named the provider that had one.
describe('the fallback model', () => {
  beforeEach(resetDb);
  it('is the default model of the first provider that has a key', async () => {
    expect(fallbackModel({ anthropic: 'a' })).toBe('anthropic:claude-sonnet-5-5');
    expect(fallbackModel({ openai: 'k' })).toBe('openai:gpt-6-luna');
    expect(fallbackModel({ openai: 'k', openrouter: 'o' })).toBe('openai/gpt-6-luna');
    expect(fallbackModel({})).toBe('openai/gpt-6-luna');
    await seed('anthropic');
    expect(await resolveModel(testEnv, { feature: 'scan' })).toBe('anthropic:claude-sonnet-5-5');
  });
  it('gives way to the default saved on Settings ▸ AI models, and ignores AI_MODEL', async () => {
    await seed('openrouter');
    await seed('anthropic');
    expect(await resolveModel({ ...testEnv, AI_MODEL: 'anthropic:claude-sonnet-5-5' } as Env)).toBe('openai/gpt-6-luna');
    await saveDefaultModel('anthropic:claude-haiku-5-5');
    expect(await resolveModel(testEnv, { feature: 'scan' })).toBe('anthropic:claude-haiku-5-5');
  });
  it('/api/health names the provider scans actually reach', async () => {
    expect(await describeOcr({ NODE_ENV: 'production' } as Env)).toBe('none');
    expect(await describeOcr({} as Env)).toBe('stub');
    await seed('anthropic');
    expect(await describeOcr(testEnv)).toBe('anthropic');
    await seed('openai');
    await saveDefaultModel('anthropic:claude-sonnet-5-5');
    expect(await describeOcr(testEnv)).toBe('anthropic');
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
  beforeEach(async () => {
    _resetCapsForTests();
    await resetDb();
    await seed('anthropic', 'a');
  });
  afterEach(() => vi.unstubAllGlobals());

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer;
  const env = testEnv;
  const message = (
    content: unknown[], stop = 'end_turn', usage: unknown = { input_tokens: 1000, output_tokens: 100 },
    container: unknown = null,
  ) =>
    new Response(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
      content, stop_reason: stop, stop_sequence: null, usage, container,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  const supported = (on: boolean) => ({ supported: on });
  // A Models API entry: current models take effort and programmatic tool
  // calling; Haiku 4.5 takes neither.
  const modelInfo = (id: string, modern = true) => ({
    type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z', lifecycle: 'active',
    max_input_tokens: 200000, max_tokens: 64000,
    capabilities: {
      effort: { supported: modern, low: supported(modern), medium: supported(modern), high: supported(modern), max: supported(modern), xhigh: null },
      code_execution: supported(modern),
      structured_outputs: supported(true),
      image_input: supported(true),
    },
  });

  /** Answers the Models API from `models`, and each message call with the next response. */
  function capture(models: Record<string, unknown> | Response[], ...responses: Response[]) {
    const infos = Array.isArray(models) ? {} : models;
    if (Array.isArray(models)) responses.unshift(...models);
    const fn = vi.fn(async (url: string | URL) => {
      const m = /\/v1\/models\/([^/?]+)/.exec(String(url));
      if (m) {
        const info = infos[decodeURIComponent(m[1]!)] ?? modelInfo(decodeURIComponent(m[1]!));
        return new Response(JSON.stringify(info), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return responses.shift()!;
    });
    vi.stubGlobal('fetch', fn);
    const calls = () => fn.mock.calls.filter(c => String(c[0]).endsWith('/v1/messages'));
    return {
      urls: () => calls().map(c => String(c[0])),
      bodies: () => calls().map(c => JSON.parse((c as unknown as [string, RequestInit])[1].body as string)),
    };
  }

  it('sends the image as base64, no temperature, low effort', async () => {
    const { urls, bodies } = capture([message([{ type: 'text', text: '{"brand":"Samsung","_confidence":0.9}' }])]);
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
    const { bodies } = capture([message(
      [{ type: 'text', text: '{"specs":{}}' }], 'end_turn',
      { input_tokens: 1_000_000, output_tokens: 0, server_tool_use: { web_search_requests: 2 } },
    )]);
    const usage: Array<{ costUsd: number }> = [];
    await aiJson(env, 'look it up', [], { webSearch: true, onUsage: (u) => usage.push(u) });
    expect(bodies()[0].tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
    // $2 per million input tokens on Sonnet 5.5, plus two searches at a cent.
    expect(usage[0]!.costUsd).toBeCloseTo(2.02);
  });

  it('leaves out effort and dynamic filtering for a model that takes neither', async () => {
    const haiku = 'claude-haiku-4-5-20251001';
    const { bodies } = capture(
      { [haiku]: modelInfo(haiku, false) },
      message([{ type: 'text', text: '{"specs":{}}' }], 'end_turn', { input_tokens: 1_000_000, output_tokens: 0 }),
    );
    const usage: Array<{ costUsd: number }> = [];
    await aiJson(env, 'look it up', [], { model: `anthropic:${haiku}`, webSearch: true, onUsage: (u) => usage.push(u) });
    const [body] = bodies();
    expect('output_config' in body).toBe(false);
    expect(body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
    // Priced by its alias, not the unknown-model rate.
    expect(usage[0]!.costUsd).toBeCloseTo(1);
  });

  it('carries on after a pause_turn, in the same container', async () => {
    const { bodies } = capture([
      message([{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }], 'pause_turn',
        undefined, { id: 'container_1', expires_at: '2026-12-01T00:00:00Z' }),
      message([{ type: 'text', text: '{"specs":{"a":"1"}}' }]),
    ]);
    expect(await aiJson(env, 'look it up', [], { webSearch: true })).toEqual({ specs: { a: '1' } });
    expect(bodies()).toHaveLength(2);
    expect('container' in bodies()[0]).toBe(false);
    expect(bodies()[1].messages[1].role).toBe('assistant');
    expect(bodies()[1].container).toBe('container_1');
  });

  it('turns a refusal into an error, and still reports what it cost', async () => {
    capture([message([], 'refusal')]);
    const usage: Array<{ costUsd: number }> = [];
    await expect(aiImageJson(env, 'p', png, { onUsage: (u) => usage.push(u) })).rejects.toThrow(/declined/);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.costUsd).toBeGreaterThan(0);
  });

  it('reports the cost of both empty turns before giving up', async () => {
    capture([message([], 'end_turn'), message([], 'end_turn')]);
    const usage: Array<{ costUsd: number }> = [];
    await expect(aiImageJson(env, 'p', png, { onUsage: (u) => usage.push(u) })).rejects.toThrow(/no content/);
    expect(usage).toHaveLength(2);
  });

  it('refuses to call a model without its key, even with one in env', async () => {
    await resetDb();
    await seed('openrouter', 'o');
    await expect(aiImageJson({ ...testEnv, ANTHROPIC_API_KEY: 'a' } as Env, 'p', png, { model: 'anthropic:claude-sonnet-5-5' }))
      .rejects.toThrow(/^No Anthropic \(Claude\) API key for anthropic:claude-sonnet-5-5: add one on Settings ▸ AI models$/);
  });

  it('a per-call model wins over the default', async () => {
    await seed('openrouter', 'o');
    const { urls } = capture([message([{ type: 'text', text: '{"a":1}' }])]);
    await aiImageJson(testEnv, 'p', png, { model: 'anthropic:claude-haiku-5-5' });
    expect(urls()[0]).toContain('api.anthropic.com');
  });

  it('shrinks an image past 2576 px before sending it', async () => {
    const big = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: '#fff' } }).png().toBuffer();
    const { bodies } = capture([message([{ type: 'text', text: '{"a":1}' }])]);
    await aiImageJson(env, 'p', big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength) as ArrayBuffer);
    const sent = Buffer.from(bodies()[0].messages[0].content[0].source.data, 'base64');
    const meta = await sharp(sent).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(2576);
  });
});

describe('the OpenAI provider', () => {
  beforeEach(async () => {
    await resetDb();
    await seed('openai');
  });
  afterEach(() => vi.unstubAllGlobals());

  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer;
  const env = testEnv;
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

  it('asks for minimal reasoning, as the OpenRouter path does', async () => {
    const fn = vi.fn(async () => response('{"serial":"ABC123"}'));
    vi.stubGlobal('fetch', fn);
    await aiImageJson(env, 'read the serial', jpg);
    const body = JSON.parse((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.reasoning).toEqual({ effort: 'minimal' });
    expect(minimalReasoning('o4-mini')).toBe('low');
    expect(minimalReasoning('gpt-4o')).toBeNull();
    expect(minimalReasoning('gpt-5-chat-latest')).toBeNull();
  });

  it('reports what an empty answer cost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response('')));
    const usage: unknown[] = [];
    await expect(aiImageJson(env, 'p', jpg, { onUsage: (u) => usage.push(u) })).rejects.toThrow(/no content/);
    expect(usage).toHaveLength(2);
  });

  it('swaps JSON mode for the web_search tool on a lookup', async () => {
    const fn = vi.fn(async () => response('{"specs":{}}'));
    vi.stubGlobal('fetch', fn);
    await aiJson(env, 'look it up', [], { webSearch: true });
    const body = JSON.parse((fn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect('text' in body).toBe(false);
    expect('reasoning' in body).toBe(false);
  });
});
