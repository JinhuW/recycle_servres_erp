import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseModelJson, PROMPT_BY_CATEGORY } from '../src/ai/prompts';
import { stubScan } from '../src/ai/stub';
import { openRouterScan } from '../src/ai/openrouter';
import { pickProvider } from '../src/ai/index';
import type { Env } from '../src/types';

describe('parseModelJson', () => {
  it('parses plain JSON', () => {
    expect(parseModelJson('{"brand":"Samsung"}')).toEqual({ brand: 'Samsung' });
  });
  it('strips ```json fences', () => {
    expect(parseModelJson('```json\n{"brand":"Micron"}\n```')).toEqual({ brand: 'Micron' });
  });
  it('extracts JSON embedded in prose', () => {
    expect(parseModelJson('Here you go: {"capacity":"32GB"} done')).toEqual({ capacity: '32GB' });
  });
  it('returns null when no JSON present', () => {
    expect(parseModelJson('no json here')).toBeNull();
  });
});

describe('PROMPT_BY_CATEGORY', () => {
  it('RAM prompt encodes the PC-code rule', () => {
    expect(PROMPT_BY_CATEGORY.RAM).toContain('PC4');
    expect(PROMPT_BY_CATEGORY.RAM).toContain('"generation"');
    expect(PROMPT_BY_CATEGORY.RAM).toContain('Desktop|Server|Laptop');
  });
  it.each(['RAM', 'SSD', 'HDD', 'Other'] as const)(
    'asks the model for an explicit _confidence value (%s)',
    (cat) => {
      expect(PROMPT_BY_CATEGORY[cat]).toContain('_confidence');
    },
  );
});

describe('stubScan', () => {
  it('returns canned RAM extraction by default', () => {
    const r = stubScan({} as Env, 'RAM');
    expect(r.provider).toBe('stub');
    expect(r.confidence).toBe(0.94);
    expect(r.fields.brand).toBe('Samsung');
    expect(r.fields.generation).toBe('DDR4');
    expect(r.fields.type).toBe('Server');
  });
  it('STUB_LOW_CONF=true → low confidence, empty fields', () => {
    const r = stubScan({ STUB_LOW_CONF: 'true' } as Env, 'SSD');
    expect(r.confidence).toBe(0.3);
    expect(r.fields).toEqual({});
    expect(r.provider).toBe('stub');
    expect(r.category).toBe('SSD');
  });
  it.each(['RAM', 'SSD', 'HDD', 'Other'] as const)(
    'returns correct category and provider for %s',
    (cat) => {
      const r = stubScan({} as Env, cat);
      expect(r.category).toBe(cat);
      expect(r.provider).toBe('stub');
      expect(r.confidence).toBeGreaterThan(0.6);
    },
  );
});

describe('openRouterScan', () => {
  afterEach(() => vi.unstubAllGlobals());

  const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer; // JPEG magic

  function mockFetch(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })),
    );
  }

  it('parses a valid completion and reads model-reported confidence', async () => {
    mockFetch(200, { choices: [{ message: { content: '{"brand":"Samsung","capacity":"32GB","_confidence":0.72}' } }] });
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.provider).toBe('openrouter');
    // Self-rated 0.72 exceeds the coverage floor (2/8 fields → 0.2), so it wins.
    expect(r.confidence).toBe(0.72);
    expect(r.fields).toEqual({ brand: 'Samsung', capacity: '32GB' });
  });

  it('defaults confidence to 0.45 when the model omits _confidence', async () => {
    mockFetch(200, { choices: [{ message: { content: '{"brand":"Samsung"}' } }] });
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    // 1/8 RAM fields → coverage floor 0.1, default 0.45 wins. Sits just below
    // CONFIDENCE_FLOOR so the UI still surfaces a "please verify" banner.
    expect(r.confidence).toBe(0.45);
    expect(r.fields).toEqual({ brand: 'Samsung' });
  });

  it('clamps out-of-range _confidence into [0,1]', async () => {
    mockFetch(200, { choices: [{ message: { content: '{"brand":"Samsung","_confidence":1.4}' } }] });
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.confidence).toBe(1);
    expect(r.fields._confidence).toBeUndefined();
  });

  it('treats a non-numeric _confidence as missing (default 0.45)', async () => {
    mockFetch(200, { choices: [{ message: { content: '{"brand":"Samsung","_confidence":"high"}' } }] });
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.confidence).toBe(0.45);
    expect(r.fields._confidence).toBeUndefined();
  });

  it('lifts a harsh self-rating when field coverage is high', async () => {
    // Model returned all 8 expected RAM fields but rated itself a pessimistic
    // 0.4. The coverage floor (8/8 * 0.8 = 0.8) overrides, since the prompt
    // tells the model to omit fields it can't read — a full set IS evidence.
    mockFetch(200, { choices: [{ message: { content: JSON.stringify({
      brand: 'Samsung', capacity: '32GB', generation: 'DDR4', type: 'Server',
      classification: 'RDIMM', rank: '2Rx4', speed: '3200', partNumber: 'M393A4K40CB2',
      _confidence: 0.4,
    }) } }] });
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.confidence).toBe(0.8);
  });

  it('coverage floor never drops a strong self-rating', async () => {
    // Model returned only 1 of 8 RAM fields but rated itself 0.92. Self-rated
    // wins — the coverage floor only acts as a lower bound.
    mockFetch(200, { choices: [{ message: { content: '{"partNumber":"M393A4K40CB2","_confidence":0.92}' } }] });
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.confidence).toBe(0.92);
  });

  it('parses fenced JSON content', async () => {
    mockFetch(200, { choices: [{ message: { content: '```json\n{"brand":"Micron"}\n```' } }] });
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.fields.brand).toBe('Micron');
  });

  it('throws on non-2xx (fail-fast)', async () => {
    mockFetch(500, 'upstream boom');
    await expect(openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img)).rejects.toThrow(/OpenRouter 500/);
  });

  it('throws when no API key', async () => {
    await expect(openRouterScan({} as Env, 'RAM', img)).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it('throws when content is unparseable', async () => {
    mockFetch(200, { choices: [{ message: { content: 'no json at all' } }] });
    await expect(openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img)).rejects.toThrow(/parse/);
  });

  it('retries once when first reply is unparseable, then parses', async () => {
    const calls: string[] = ['not json', '{"brand":"Crucial"}'];
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: calls.shift()! } }] }), { status: 200 }),
    ));
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.fields.brand).toBe('Crucial');
    expect(calls.length).toBe(0);
  });
});

describe('pickProvider', () => {
  it('stub when no OpenRouter key', () => {
    expect(pickProvider({} as Env)).toBe('stub');
  });
  it('openrouter when key present', () => {
    expect(pickProvider({ OPENROUTER_API_KEY: 'k' } as Env)).toBe('openrouter');
  });
});
