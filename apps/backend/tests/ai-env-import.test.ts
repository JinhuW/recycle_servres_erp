import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { aiKeys, importEnvAiSettings, invalidateAiKeys } from '../src/ai/keys';
import { resolveModel } from '../src/ai/llm';
import type { Env } from '../src/types';

const TRACKER = { TRACKER_API_URL: 'http://tracker.test', TRACKER_API_TOKEN: 'tracker-token' };
const KEY = 'sk-or-env-key-wxyz';

type Push = { url: string; method: string; body: string | null };

function stubTracker(status = 200): Push[] {
  const pushes: Push[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    pushes.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return new Response('{}', { status });
  }));
  return pushes;
}

const env = (over: Partial<Env> = {}) => ({ ...testEnv, ...TRACKER, ...over }) as Env;
const db = () => getTestDb();
const marker = async () =>
  (await db()<{ value: unknown }[]>`SELECT value FROM workspace_settings WHERE key = 'ai_env_imported'`)[0]?.value;
const aiModels = async () =>
  (await db()<{ value: unknown }[]>`SELECT value FROM workspace_settings WHERE key = 'ai_models'`)[0]?.value;

describe('importing the old AI env vars at boot', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateAiKeys();
  });

  it('stores each env key sealed, pushes it to the tracker, and writes the marker', async () => {
    const pushes = stubTracker();
    const done = await importEnvAiSettings(env({ OPENROUTER_API_KEY: KEY, ANTHROPIC_API_KEY: ' sk-ant-1234 ' }));
    expect(done).toMatchObject({ providers: ['openrouter', 'anthropic'], model: false });

    const rows = await db()<{ provider: string; sealed: string; last4: string; updated_by: string | null; tracker_synced: boolean }[]>`
      SELECT provider, sealed, last4, updated_by, tracker_synced FROM ai_provider_keys ORDER BY provider`;
    expect(rows.map(r => [r.provider, r.last4, r.updated_by, r.tracker_synced])).toEqual([
      ['anthropic', '1234', null, true],
      ['openrouter', 'wxyz', null, true],
    ]);
    expect(rows.every(r => r.sealed.startsWith('v1.') && !r.sealed.includes(KEY))).toBe(true);
    expect(pushes.map(p => [p.method, p.url, JSON.parse(p.body!)])).toEqual([
      ['PUT', 'http://tracker.test/api/llm-keys/openrouter', { key: KEY }],
      ['PUT', 'http://tracker.test/api/llm-keys/anthropic', { key: 'sk-ant-1234' }],
    ]);
    expect(await marker()).toMatchObject({ providers: ['openrouter', 'anthropic'], model: false });
    // Read back from the table, with no env key in sight.
    expect(await aiKeys(testEnv)).toEqual({ openrouter: KEY, anthropic: 'sk-ant-1234' });
  });

  it('records a push the tracker missed, for the page to retry', async () => {
    stubTracker(503);
    await importEnvAiSettings(env({ OPENROUTER_API_KEY: KEY }));
    expect(await db()`SELECT tracker_synced FROM ai_provider_keys`).toEqual([{ tracker_synced: false }]);
  });

  it('runs once: a later boot imports nothing, even a new env key', async () => {
    stubTracker();
    await importEnvAiSettings(env({ OPENROUTER_API_KEY: KEY }));
    expect(await importEnvAiSettings(env({ OPENROUTER_API_KEY: KEY, OPENAI_API_KEY: 'sk-openai' }))).toBeNull();
    expect(await db()`SELECT provider FROM ai_provider_keys`).toEqual([{ provider: 'openrouter' }]);
  });

  it('never brings back a key removed on the page', async () => {
    stubTracker();
    await importEnvAiSettings(env({ OPENROUTER_API_KEY: KEY }));
    const { token } = await loginAs(ALEX);
    expect((await api('DELETE', '/api/ai/keys/openrouter', { token, env: TRACKER })).status).toBe(200);

    expect(await importEnvAiSettings(env({ OPENROUTER_API_KEY: KEY }))).toBeNull();
    expect(await db()`SELECT 1 FROM ai_provider_keys`).toHaveLength(0);
  });

  it('skips a provider with a saved key or a removal still pending', async () => {
    const pushes = stubTracker();
    await db()`INSERT INTO ai_provider_keys (provider, sealed, last4, tracker_synced) VALUES ('openai', 'v1.x.y.z', 'zzzz', TRUE)`;
    await db()`INSERT INTO ai_provider_key_removals (provider) VALUES ('anthropic')`;
    const done = await importEnvAiSettings(env({
      OPENROUTER_API_KEY: KEY, ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-openai',
    }));
    expect(done!.providers).toEqual(['openrouter']);
    expect(pushes.map(p => p.url)).toEqual(['http://tracker.test/api/llm-keys/openrouter']);
    expect(await db()`SELECT last4 FROM ai_provider_keys WHERE provider = 'openai'`).toEqual([{ last4: 'zzzz' }]);
    expect(await db()`SELECT 1 FROM ai_provider_keys WHERE provider = 'anthropic'`).toHaveLength(0);
  });

  it('seeds ai_models.default from AI_MODEL only while it is empty', async () => {
    stubTracker();
    await db()`
      INSERT INTO workspace_settings (key, value) VALUES ('ai_models', ${db().json({ default: null, scan: 'openai/gpt-6-luna' })})`;
    const done = await importEnvAiSettings(env({ ANTHROPIC_API_KEY: 'sk-ant', AI_MODEL: 'anthropic:claude-sonnet-5-5' }));
    expect(done!.model).toBe(true);
    expect(await aiModels()).toEqual({ default: 'anthropic:claude-sonnet-5-5', scan: 'openai/gpt-6-luna' });
    expect(await resolveModel(testEnv)).toBe('anthropic:claude-sonnet-5-5');
  });

  it('leaves a chosen default alone', async () => {
    stubTracker();
    await db()`
      INSERT INTO workspace_settings (key, value) VALUES ('ai_models', ${db().json({ default: 'openai:gpt-6-luna' })})`;
    const done = await importEnvAiSettings(env({ OPENAI_API_KEY: 'sk-openai', AI_MODEL: 'openai:gpt-5' }));
    expect(done!.model).toBe(false);
    expect(await aiModels()).toEqual({ default: 'openai:gpt-6-luna' });
  });

  it('takes OPENROUTER_OCR_MODEL when AI_MODEL is unset, but not a model with no key', async () => {
    stubTracker();
    await importEnvAiSettings(env({ OPENROUTER_API_KEY: KEY, OPENROUTER_OCR_MODEL: 'google/gemini-2.5-flash' }));
    expect(await aiModels()).toEqual({ default: 'google/gemini-2.5-flash' });

    await resetDb();
    const done = await importEnvAiSettings(env({ AI_MODEL: 'anthropic:claude-sonnet-5-5' }));
    expect(done).toMatchObject({ providers: [], model: false });
    expect(await aiModels()).toBeUndefined();
  });

  it('imports nothing, and leaves no marker, when keys cannot be sealed', async () => {
    const pushes = stubTracker();
    const prod = env({ NODE_ENV: 'production', FB_POOL_KEY: undefined, OPENROUTER_API_KEY: KEY });
    expect(await importEnvAiSettings(prod)).toBeNull();
    expect(await db()`SELECT 1 FROM ai_provider_keys`).toHaveLength(0);
    expect(await marker()).toBeUndefined();
    expect(pushes).toHaveLength(0);
  });

  it('never throws, so a database it cannot reach does not stop the boot', async () => {
    const down = env({ DATABASE_URL: 'postgres://nobody:x@127.0.0.1:1/none', OPENROUTER_API_KEY: KEY });
    await expect(importEnvAiSettings(down)).resolves.toBeNull();
  });

  it('keeps the marker out of reach of PATCH /api/workspace', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('PATCH', '/api/workspace', { token, body: { ai_env_imported: null } });
    expect(r.status).toBe(400);
  });
});
