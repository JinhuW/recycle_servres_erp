import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseModelJson, PROMPT_BY_CATEGORY } from '../src/ai/prompts';
import { stubScan } from '../src/ai/stub';
import { openRouterScan } from '../src/ai/openrouter';
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
    expect(PROMPT_BY_CATEGORY.RAM).toContain('SODIMM = laptop');
  });
});

describe('stubScan', () => {
  it('returns canned RAM extraction by default', () => {
    const r = stubScan({} as Env, 'RAM');
    expect(r.provider).toBe('stub');
    expect(r.confidence).toBe(0.94);
    expect(r.fields.brand).toBe('Samsung');
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

  it('parses a valid completion', async () => {
    mockFetch(200, { choices: [{ message: { content: '{"brand":"Samsung","capacity":"32GB"}' } }] });
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.provider).toBe('openrouter');
    expect(r.confidence).toBe(0.85);
    expect(r.fields).toEqual({ brand: 'Samsung', capacity: '32GB' });
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
});
