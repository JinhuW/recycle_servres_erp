// The merged model catalogue without the route: OpenAI entries borrowing
// OpenRouter's facts, prices for the PO review's cost cap, and a key change
// racing a fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetForTests, cachedPrice, catalogue, dropCatalogue, priceFor } from '../src/ai/catalogue';
import type { Env } from '../src/types';

const OPENROUTER = {
  data: [
    {
      id: 'openai/gpt-6-luna', name: 'OpenAI: GPT-6 Luna', context_length: 400000,
      pricing: { prompt: '0.0000002', completion: '0.0000008' },
      supported_parameters: ['structured_outputs', 'response_format'],
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    },
    {
      id: 'openai/gpt-3.5-turbo', name: 'OpenAI: GPT-3.5 Turbo', context_length: 16385,
      pricing: { prompt: '0.0000005', completion: '0.0000015' },
      supported_parameters: ['response_format'],
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
  ],
};
const OPENAI = { object: 'list', data: ['gpt-6-luna', 'gpt-3.5-turbo', 'o3-mini'].map((id) => ({ id, object: 'model', created: 0, owned_by: 'openai' })) };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function stub(answers: { openrouter?: () => Promise<Response>; openai?: () => Promise<Response> } = {}) {
  const fn = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith('https://openrouter.ai/api/v1/models')) return (answers.openrouter ?? (async () => json(OPENROUTER)))();
    if (u.startsWith('https://api.openai.com/v1/models')) return (answers.openai ?? (async () => json(OPENAI)))();
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('the merged catalogue', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => vi.unstubAllGlobals());

  it("gives an OpenAI model OpenRouter's facts for it, and leaves an unknown one text-only", async () => {
    stub();
    const { models } = await catalogue({ OPENAI_API_KEY: 'k' } as Env);
    const byId = new Map(models.map((m) => [m.id, m]));
    expect(byId.get('openai:gpt-6-luna')).toMatchObject({
      structuredOutputs: true, inputModalities: ['text', 'image'], promptPerM: 0.2, completionPerM: 0.8, contextLength: 400000,
    });
    expect(byId.get('openai:gpt-3.5-turbo')).toMatchObject({ structuredOutputs: false, inputModalities: ['text'] });
    expect(byId.get('openai:o3-mini')).toMatchObject({ structuredOutputs: false, inputModalities: ['text'], promptPerM: null });
  });
});

describe('prices for the cost cap', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('fetches OpenRouter\'s list for an OpenAI price when nothing is cached', async () => {
    const fn = stub();
    expect(cachedPrice('openai:gpt-6-luna')).toBeUndefined();
    expect(await priceFor('openai:gpt-6-luna')).toEqual([0.2, 0.8]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not wait again straight after OpenRouter failed', async () => {
    const fn = stub({ openrouter: async () => new Response('down', { status: 503 }) });
    expect(await priceFor('openai:gpt-6-luna')).toBeUndefined();
    expect(await priceFor('openai:gpt-6-luna')).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never fetches for a provider that prices its own calls', async () => {
    const fn = stub();
    expect(await priceFor('anthropic:claude-sonnet-5-5')).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('a key change during a fetch', () => {
  beforeEach(() => _resetForTests());
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the list fetched before the drop out of the cache', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    stub({ openrouter: async () => { await held; return json(OPENROUTER); } });
    const pending = catalogue({} as Env);
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    dropCatalogue('openrouter');
    release();
    await pending;
    expect(cachedPrice('openai/gpt-6-luna')).toBeUndefined();
  });
});
