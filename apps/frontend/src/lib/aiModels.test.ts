import { describe, it, expect } from 'vitest';
import {
  modelMeta, modelShapeHintKey, modelsFor, preselectModel, READS_IMAGES, TEXT_JSON_MODEL, type AiModel,
} from './aiModels';

const t = (key: string, vars?: Record<string, string | number>) =>
  key + (vars ? JSON.stringify(vars) : '');

const model = (over: Partial<AiModel>): AiModel => ({
  id: 'openai/gpt-4o-mini',
  provider: 'openrouter',
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

describe('which models a provider dropdown offers and preselects', () => {
  const catalogue = [
    model({ id: '~openai/gpt-latest', inputModalities: ['text', 'image'] }),
    model({ id: 'openai/gpt-4o-mini', inputModalities: ['text'] }),
    model({ id: 'openai/gpt-6-luna', inputModalities: ['text', 'image'] }),
    model({ id: 'openai:o3-mini', provider: 'openai', inputModalities: ['text'], structuredOutputs: false }),
    model({ id: 'openai:gpt-6-luna', provider: 'openai', inputModalities: ['text', 'image'] }),
  ];

  it('never lists an id a setting cannot hold, such as an OpenRouter ~alias', () => {
    expect(catalogue.filter(modelsFor('openrouter')).map(m => m.id)).toEqual(['openai/gpt-4o-mini', 'openai/gpt-6-luna']);
  });

  it("preselects the first model the row's filter vouches for", () => {
    expect(preselectModel(catalogue, 'openrouter', READS_IMAGES)).toBe('openai/gpt-6-luna');
    expect(preselectModel(catalogue, 'openai', READS_IMAGES)).toBe('openai:gpt-6-luna');
    expect(preselectModel(catalogue, 'openai', TEXT_JSON_MODEL)).toBe('openai:gpt-6-luna');
  });

  it('preselects nothing without a filter, or when no model passes it', () => {
    expect(preselectModel(catalogue, 'openrouter')).toBe('');
    expect(preselectModel(catalogue, 'anthropic', READS_IMAGES)).toBe('');
    expect(preselectModel(null, 'openai', READS_IMAGES)).toBe('');
  });
});

describe('modelShapeHintKey', () => {
  it('explains the shape of the provider the ref names', () => {
    expect(modelShapeHintKey('gpt-4o')).toBe('trkModelInvalid');
    expect(modelShapeHintKey('anthropic:claude/sonnet')).toBe('trkModelInvalidDirect');
    expect(modelShapeHintKey('openai:a b')).toBe('trkModelInvalidDirect');
  });
});
