import { describe, it, expect } from 'vitest';
import { parseModelJson, PROMPT_BY_CATEGORY } from '../src/ai/prompts';

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
