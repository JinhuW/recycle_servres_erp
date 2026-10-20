import { describe, it, expect } from 'vitest';
import { modelMeta, TEXT_JSON_MODEL, type AiModel } from './aiModels';

const t = (key: string, vars?: Record<string, string | number>) =>
  key + (vars ? JSON.stringify(vars) : '');

const model = (over: Partial<AiModel>): AiModel => ({
  id: 'openai/gpt-4o-mini',
  name: 'OpenAI: GPT-4o-mini',
  contextLength: 128000,
  promptPerM: 0.15,
  completionPerM: 0.6,
  structuredOutputs: true,
  inputModalities: ['text'],
  outputModalities: ['text'],
  ...over,
});

describe('modelMeta', () => {
  it('reads price per million tokens and a compact context size', () => {
    expect(modelMeta(model({}), 'en', t))
      .toBe('aiModelPrice{"prompt":"$0.15","completion":"$0.60"} · aiModelContext{"n":"128K"}');
  });

  it('keeps three significant digits on sub-cent prices', () => {
    expect(modelMeta(model({ promptPerM: 0.0375, completionPerM: 15, contextLength: null }), 'en', t))
      .toBe('aiModelPrice{"prompt":"$0.0375","completion":"$15.00"}');
  });

  it('says free for a zero price and leaves the price out for a router', () => {
    expect(modelMeta(model({ promptPerM: 0, completionPerM: 0, contextLength: 1_048_576 }), 'en', t))
      .toBe('aiModelFree · aiModelContext{"n":"1M"}');
    expect(modelMeta(model({ promptPerM: null, completionPerM: null }), 'en', t))
      .toBe('aiModelContext{"n":"128K"}');
  });
});

describe('TEXT_JSON_MODEL', () => {
  it('keeps only text models that honour a strict JSON schema', () => {
    expect(TEXT_JSON_MODEL(model({}))).toBe(true);
    expect(TEXT_JSON_MODEL(model({ structuredOutputs: false }))).toBe(false);
    expect(TEXT_JSON_MODEL(model({ outputModalities: ['image'] }))).toBe(false);
  });
});
