import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { _resetForTests } from '../src/routes/aiModels';

// Two entries in OpenRouter's shape, plus the oddities the trimmer has to
// survive: a router priced at -1 and an entry with no id.
const CATALOGUE = {
  data: [
    {
      id: 'openai/gpt-4o-mini',
      name: 'OpenAI: GPT-4o-mini',
      context_length: 128000,
      pricing: { prompt: '0.00000015', completion: '0.0000006', web_search: '0.01' },
      supported_parameters: ['response_format', 'structured_outputs', 'temperature'],
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      description: 'dropped',
    },
    {
      id: 'openrouter/auto',
      name: 'Auto Router',
      context_length: 2000000,
      pricing: { prompt: '-1', completion: '-1' },
      supported_parameters: ['temperature'],
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
    { name: 'no id' },
  ],
};

function stubOpenRouter(...answers: Array<{ status: number; body: unknown } | 'down'>) {
  const spy = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('OpenRouter model catalogue (/api/ai/models)', () => {
  beforeEach(async () => {
    await resetDb();
    _resetForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('trims the catalogue to what a picker shows, sorted by id', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubOpenRouter({ status: 200, body: CATALOGUE });

    const r = await api<{ models: unknown[]; fetchedAt: string }>('GET', '/api/ai/models', { token });

    expect(r.status).toBe(200);
    expect(r.body.models).toEqual([
      {
        id: 'openai/gpt-4o-mini',
        name: 'OpenAI: GPT-4o-mini',
        contextLength: 128000,
        promptPerM: 0.15,
        completionPerM: 0.6,
        structuredOutputs: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
      {
        id: 'openrouter/auto',
        name: 'Auto Router',
        contextLength: 2000000,
        promptPerM: null,
        completionPerM: null,
        structuredOutputs: false,
        inputModalities: ['text'],
        outputModalities: ['text'],
      },
    ]);
    expect(Number.isNaN(Date.parse(r.body.fetchedAt))).toBe(false);
    expect((spy.mock.calls[0] as unknown[])[0]).toBe('https://openrouter.ai/api/v1/models');
  });

  it('serves the cached copy instead of asking OpenRouter again', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubOpenRouter({ status: 200, body: CATALOGUE });

    const first = await api<{ fetchedAt: string }>('GET', '/api/ai/models', { token });
    const second = await api<{ fetchedAt: string }>('GET', '/api/ai/models', { token });

    expect(second.status).toBe(200);
    expect(second.body.fetchedAt).toBe(first.body.fetchedAt);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the last copy when a refresh fails, and does not retry on every read', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubOpenRouter({ status: 200, body: CATALOGUE }, { status: 503, body: {} });

    const first = await api<{ fetchedAt: string }>('GET', '/api/ai/models', { token });
    _resetForTests({ expire: true });
    const stale = await api<{ models: unknown[]; fetchedAt: string }>('GET', '/api/ai/models', { token });
    const again = await api<{ fetchedAt: string }>('GET', '/api/ai/models', { token });

    expect(stale.status).toBe(200);
    expect(stale.body.models).toHaveLength(2);
    expect(stale.body.fetchedAt).toBe(first.body.fetchedAt);
    expect(again.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('answers 502 naming OpenRouter when there is no copy to fall back on', async () => {
    const { token } = await loginAs(ALEX);
    for (const answer of ['down', { status: 500, body: {} }, { status: 200, body: { data: [] } }] as const) {
      _resetForTests();
      stubOpenRouter(answer);
      const r = await api<{ error: string }>('GET', '/api/ai/models', { token });
      expect(r.status, JSON.stringify(answer)).toBe(502);
      expect(r.body.error).toMatch(/OpenRouter/);
    }
  });

  it('is manager-only', async () => {
    expect((await api('GET', '/api/ai/models')).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    const spy = stubOpenRouter({ status: 200, body: CATALOGUE });
    expect((await api('GET', '/api/ai/models', { token })).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });
});
