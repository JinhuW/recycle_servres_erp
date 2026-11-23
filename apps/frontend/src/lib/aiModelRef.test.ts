import { describe, it, expect } from 'vitest';
import { formatModelRef, isAiModelsSetting, isModelRef, parseModelRef } from '@recycle-erp/shared';

// packages/shared has no runner; its pure helpers are tested here.

describe('model refs', () => {
  it('reads a bare id as OpenRouter, so settings saved before providers keep their meaning', () => {
    expect(parseModelRef('openai/gpt-6-luna')).toEqual({ provider: 'openrouter', model: 'openai/gpt-6-luna' });
    expect(parseModelRef('google/gemini-2.5-flash:online'))
      .toEqual({ provider: 'openrouter', model: 'google/gemini-2.5-flash:online' });
    expect(parseModelRef('openrouter:openai/gpt-6-luna')).toEqual({ provider: 'openrouter', model: 'openai/gpt-6-luna' });
    expect(parseModelRef('anthropic:claude-sonnet-5-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
    expect(parseModelRef('openai:gpt-6-luna')).toEqual({ provider: 'openai', model: 'gpt-6-luna' });
    expect(parseModelRef('gemini:x')).toEqual({ provider: 'openrouter', model: 'gemini:x' });
  });

  it('formats a prefixed ref that parses back', () => {
    expect(parseModelRef(formatModelRef('anthropic', 'claude-haiku-4-5'))).toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  it('validates each provider by its own id shape', () => {
    expect(isModelRef('openai/gpt-6-luna')).toBe(true);
    expect(isModelRef('openrouter:openai/gpt-6-luna')).toBe(true);
    expect(isModelRef('anthropic:claude-sonnet-5-5')).toBe(true);
    expect(isModelRef('anthropic:claude/sonnet')).toBe(false);
    expect(isModelRef('gpt-4o')).toBe(false);
    expect(isModelRef('~openai/gpt-latest')).toBe(false);
    expect(isModelRef('not a model')).toBe(false);
    expect(isModelRef(`openai:${'x'.repeat(200)}`)).toBe(false);
    expect(isModelRef(42)).toBe(false);
  });
});

describe('isAiModelsSetting', () => {
  it('takes the default and the known features, each a ref or null', () => {
    expect(isAiModelsSetting({ default: null })).toBe(true);
    expect(isAiModelsSetting({ default: 'anthropic:claude-sonnet-5-5', scan: null, serial: 'openai/gpt-6-luna' })).toBe(true);
  });

  it('refuses unknown keys, bad refs and non-objects', () => {
    expect(isAiModelsSetting({ default: null, chat: 'openai/gpt-6-luna' })).toBe(false);
    expect(isAiModelsSetting({ default: 'gpt-4o' })).toBe(false);
    expect(isAiModelsSetting([])).toBe(false);
    expect(isAiModelsSetting(null)).toBe(false);
  });
});
