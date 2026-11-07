// The agent's model transport: a strict-schema chat call on OpenRouter, with
// fetch stubbed (no key, no network). The image callers' request is pinned by
// ai.test.ts and po-ai-review.test.ts, which this change leaves alone.

import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import type { Sql } from 'postgres';
import { FB_SELLER_DEFAULT_SETTINGS } from '@recycle-erp/shared';
import { openRouterChatJson } from '../src/ai/openrouter';
import { agentLlmFor, agentSpentTodayUsd } from '../src/services/fbAgent';
import { EXTRACT_SCHEMA } from '../src/services/fbAgent/prompt';
import { getTestDb, resetDb } from './helpers/db';
import { testEnv } from './helpers/app';

const env = { ...testEnv, OPENROUTER_API_KEY: 'test-key' };

function stubFetch(answer: unknown, status = 200) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(answer), { status });
  }));
  return seen;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('openRouterChatJson', () => {
  it('sends a system turn, the history and a strict json_schema, and returns usage', async () => {
    const seen = stubFetch({
      choices: [{ message: { content: '{"reply":"Hello"}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 8, cost: 0.0004 },
    });
    const onUsage = vi.fn();
    const r = await openRouterChatJson(env, {
      model: 'openai/gpt-6-luna', system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'got ram' }],
      schema: { type: 'object' }, schemaName: 'agent',
    }, { onUsage });
    expect(r).toEqual({ json: { reply: 'Hello' }, usage: { promptTokens: 120, completionTokens: 8, costUsd: 0.0004 } });
    expect(onUsage).toHaveBeenCalledOnce();
    const body = seen[0]!.body;
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'got ram' },
    ]);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'agent', strict: true, schema: { type: 'object' } } });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.usage).toEqual({ include: true });
  });

  it('throws on an HTTP error and on an answer that is not JSON', async () => {
    stubFetch({ error: 'nope' }, 502);
    await expect(openRouterChatJson(env, { model: 'm/x', system: '', messages: [], schema: {} })).rejects.toThrow(/OpenRouter 502/);
    stubFetch({ choices: [{ message: { content: 'not json' } }] });
    await expect(openRouterChatJson(env, { model: 'm/x', system: '', messages: [], schema: {} })).rejects.toThrow(/not JSON/);
  });

  it('refuses without a key', async () => {
    await expect(openRouterChatJson({ ...testEnv, OPENROUTER_API_KEY: undefined }, { model: 'm/x', system: '', messages: [], schema: {} }))
      .rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});

describe('agentLlmFor', () => {
  it('maps usage onto AgentDecision.usage with the model asked for', async () => {
    stubFetch({ choices: [{ message: { content: '{"intent":"question"}' } }], usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.01 } });
    const r = await agentLlmFor(env)({ model: 'openai/gpt-6-luna', system: 's', messages: [{ role: 'user', content: 'u' }], schema: EXTRACT_SCHEMA });
    expect(r).toEqual({ json: { intent: 'question' }, usage: { model: 'openai/gpt-6-luna', prompt_tokens: 5, completion_tokens: 2, cost_usd: 0.01 } });
  });
});

describe('agentSpentTodayUsd', () => {
  beforeAll(async () => { await resetDb(); });

  it('sums every run today in the seller time zone, shadow and eval included', async () => {
    const db = getTestDb() as unknown as Sql;
    await db`INSERT INTO fb_agent_runs (cost_usd, shadow, created_at) VALUES
      (0.5, FALSE, NOW()), (0.25, TRUE, NOW()), (1, FALSE, NOW() - INTERVAL '3 days')`;
    expect(await agentSpentTodayUsd(db, FB_SELLER_DEFAULT_SETTINGS)).toBeCloseTo(0.75);
  });
});
