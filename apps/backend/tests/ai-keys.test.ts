import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { getDb } from '../src/db';
import { invalidateAiKeys } from '../src/ai/keys';
import { _resetForTests } from '../src/ai/catalogue';
import { aiImageJson } from '../src/ai/llm';
import { describeOcr, featureProvider, NO_KEY_ERROR } from '../src/ai/index';
import type { Env } from '../src/types';

const TRACKER = { TRACKER_API_URL: 'http://tracker.test', TRACKER_API_TOKEN: 'tracker-token' };
const KEY = 'sk-ant-test-key-abcd1234';
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer;

type Call = { url: string; method: string; headers: Headers; body: string | null };

/** Fakes Anthropic's model list and messages, and the tracker's key route. */
function stubUpstreams({ anthropic = 200, tracker = 200 } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({
      url, method: init?.method ?? 'GET', headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('http://tracker.test')) return json(tracker, tracker === 200 ? { ok: true, last4: '1234' } : {});
    if (url.includes('/v1/models')) {
      if (anthropic !== 200) return json(anthropic, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      return json(200, {
        data: [{ type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-01-01T00:00:00Z', capabilities: null, max_input_tokens: 1000000, lifecycle: 'active' }],
        has_more: false, first_id: 'claude-sonnet-5-5', last_id: 'claude-sonnet-5-5',
      });
    }
    if (url.includes('/v1/messages')) {
      return json(200, {
        id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
        content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }
    return json(404, {});
  }));
  return calls;
}

/** The credential an SDK call carried, whichever header the SDK puts it in. */
const credential = (c: Call) => c.headers.get('x-api-key') ?? c.headers.get('authorization')?.replace(/^Bearer /, '');

describe('AI provider keys pasted on Settings ▸ AI models', () => {
  let token: string;
  beforeEach(async () => {
    await resetDb();
    invalidateAiKeys();
    _resetForTests();
    ({ token } = await loginAs(ALEX));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    invalidateAiKeys();
  });

  const put = (key: string, env: Partial<Env> = TRACKER) =>
    api<{ ok?: boolean; last4?: string; trackerSynced?: boolean; trackerError?: string; error?: string }>(
      'PUT', '/api/ai/keys/anthropic', { token, env, body: { key } });
  const providers = (env: Partial<Env> = {}) =>
    api<{ providers: Array<{ id: string; configured: boolean; source: string | null; last4: string | null; trackerSynced: boolean | null }> }>(
      'GET', '/api/ai/providers', { token, env });

  it('tests the key, stores it sealed, pushes it to the tracker, and shows only its last four', async () => {
    const calls = stubUpstreams();
    const r = await put(KEY);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, last4: '1234', trackerSynced: true });

    const test = calls.find(c => c.url.includes('/v1/models'))!;
    expect(credential(test)).toBe(KEY);

    const push = calls.find(c => c.url === 'http://tracker.test/api/llm-keys/anthropic')!;
    expect(push.method).toBe('PUT');
    expect(push.headers.get('authorization')).toBe('Bearer tracker-token');
    expect(JSON.parse(push.body!)).toEqual({ key: KEY });

    const [row] = await getDb(testEnv)<{ sealed: string; last4: string; tracker_synced: boolean }[]>`
      SELECT sealed, last4, tracker_synced FROM ai_provider_keys WHERE provider = 'anthropic'`;
    expect(row!.sealed).not.toContain(KEY);
    expect(row!.sealed).toMatch(/^v1\./);
    expect(row!.tracker_synced).toBe(true);

    const p = await providers();
    expect(p.body.providers.find(x => x.id === 'anthropic'))
      .toMatchObject({ configured: true, source: 'ui', last4: '1234', trackerSynced: true });
    expect(JSON.stringify(p.body)).not.toContain(KEY);
  });

  it('refuses a key the provider rejects, and stores nothing', async () => {
    const calls = stubUpstreams({ anthropic: 401 });
    const r = await put(KEY);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/rejected this key/);
    expect(calls.some(c => c.url.startsWith('http://tracker.test'))).toBe(false);
    expect(await getDb(testEnv)`SELECT 1 FROM ai_provider_keys`).toHaveLength(0);
  });

  it('keeps the key when the tracker is down, and says so', async () => {
    stubUpstreams({ tracker: 503 });
    const r = await put(KEY);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ trackerSynced: false, trackerError: 'Tracker answered 503' });
    expect((await providers()).body.providers.find(x => x.id === 'anthropic')!.trackerSynced).toBe(false);
  });

  it('wins over the env key for model calls, and removing it falls back to env', async () => {
    const calls = stubUpstreams();
    await put(KEY);
    const env = { ...testEnv, ANTHROPIC_API_KEY: 'env-key', AI_MODEL: 'anthropic:claude-sonnet-5-5' } as Env;

    await aiImageJson(env, 'p', png);
    expect(credential(calls.filter(c => c.url.includes('/v1/messages')).at(-1)!)).toBe(KEY);

    const del = await api<{ ok: boolean; trackerSynced: boolean }>(
      'DELETE', '/api/ai/keys/anthropic', { token, env: TRACKER });
    expect(del.body).toEqual({ ok: true, trackerSynced: true });
    expect(calls.some(c => c.method === 'DELETE' && c.url === 'http://tracker.test/api/llm-keys/anthropic')).toBe(true);

    await aiImageJson(env, 'p', png);
    expect(credential(calls.filter(c => c.url.includes('/v1/messages')).at(-1)!)).toBe('env-key');
    expect((await providers({ ANTHROPIC_API_KEY: 'env-key' })).body.providers.find(x => x.id === 'anthropic'))
      .toMatchObject({ source: 'env', last4: null });
  });

  // Straight after a restart nothing has read the table yet; /api/health
  // used to report no AI at all until some scan did.
  it('/api/health sees a saved key while the cache is still cold', async () => {
    stubUpstreams();
    await put(KEY);
    invalidateAiKeys();
    expect(await describeOcr({ ...testEnv, OPENROUTER_API_KEY: undefined } as Env)).toBe('anthropic');
  });

  it('rejects a blank key, an unknown provider, and non-managers', async () => {
    stubUpstreams();
    expect((await put('   ')).status).toBe(400);
    expect((await api('PUT', '/api/ai/keys/gemini', { token, body: { key: KEY } })).status).toBe(400);
    const { token: pur } = await loginAs(MARCUS);
    expect((await api('PUT', '/api/ai/keys/anthropic', { token: pur, body: { key: KEY } })).status).toBe(403);
    expect((await api('DELETE', '/api/ai/keys/anthropic', { token: pur })).status).toBe(403);
  });
});

describe('production with no AI key anywhere', () => {
  it('refuses an AI read instead of serving stub data', async () => {
    await expect(featureProvider({ NODE_ENV: 'production' } as Env, 'scan')).rejects.toThrow(NO_KEY_ERROR);
  });
  it('still uses the stub in dev and CI', async () => {
    expect(await featureProvider({} as Env, 'scan')).toBe('stub');
  });
});
