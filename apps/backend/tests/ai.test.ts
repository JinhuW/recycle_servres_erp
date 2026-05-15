import { describe, it, expect } from 'vitest';
import { parseModelJson, PROMPT_BY_CATEGORY } from '../src/ai/prompts';
import { stubScan } from '../src/ai/stub';
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
