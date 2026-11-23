import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { getDb } from '../src/db';
import { invalidateAiKeys } from '../src/ai/keys';
import { _resetForTests } from '../src/ai/catalogue';
import { aiImageJson } from '../src/ai/llm';
import { featureProvider, NO_KEY_ERROR } from '../src/ai/index';
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

  it('rejects a blank key, an unknown provider, and non-managers', async () => {
    stubUpstreams();
    expect((await put('   ')).status).toBe(400);
    expect((await api('PUT', '/api/ai/keys/gemini', { token, body: { key: KEY } })).status).toBe(400);
    const { token: pur } = await loginAs(MARCUS);
    expect((await api('PUT', '/api/ai/keys/anthropic', { token: pur, body: { key: KEY } })).status).toBe(403);
    expect((await api('DELETE', '/api/ai/keys/anthropic', { token: pur })).status).toBe(403);
  });
});

describe('AI keys and the tracker: order of writes, retries, removals', () => {
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

  type Sync = { ok?: boolean; trackerSynced?: boolean; trackerError?: string; error?: string; usedBy?: string[] };
  const put = (env: Partial<Env> = TRACKER) => api<Sync>('PUT', '/api/ai/keys/anthropic', { token, env, body: { key: KEY } });
  const del = (env: Partial<Env> = TRACKER) => api<Sync>('DELETE', '/api/ai/keys/anthropic', { token, env });
  const sync = (env: Partial<Env> = TRACKER) => api<Sync>('POST', '/api/ai/keys/anthropic/sync', { token, env });
  const status = async () => (await api<{ providers: Array<{ id: string; configured: boolean; source: string | null; trackerSynced: boolean | null; unreadable: boolean }> }>(
    'GET', '/api/ai/providers', { token })).body.providers.find(x => x.id === 'anthropic')!;
  const db = () => getDb(testEnv);

  /** Like stubUpstreams, but records whether the key's row existed when the tracker was called. */
  function stubWithRowCheck(trackerStatus: () => number) {
    const seen: Array<{ method: string; rowExisted: boolean }> = [];
    const calls = stubUpstreams();
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('http://tracker.test')) {
        const rows = await db()`SELECT 1 FROM ai_provider_keys WHERE provider = 'anthropic'`;
        seen.push({ method: init?.method ?? 'GET', rowExisted: rows.length > 0 });
        calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : null });
        return new Response('{}', { status: trackerStatus() });
      }
      return inner(input, init);
    }));
    return { seen, calls };
  }

  it('stores the key before pushing it, then records the push', async () => {
    const { seen } = stubWithRowCheck(() => 200);
    expect((await put()).body).toMatchObject({ ok: true, trackerSynced: true });
    expect(seen).toEqual([{ method: 'PUT', rowExisted: true }]);
    expect((await db()`SELECT tracker_synced FROM ai_provider_keys`)[0]).toEqual({ tracker_synced: true });
  });

  it('pushes a removal before deleting, and keeps an unconfirmed one for a retry', async () => {
    let tracker = 200;
    const { seen, calls } = stubWithRowCheck(() => tracker);
    await put();
    tracker = 503;
    const r = await del();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ trackerSynced: false });
    expect(seen.at(-1)).toEqual({ method: 'DELETE', rowExisted: true });
    expect(await db()`SELECT 1 FROM ai_provider_keys`).toHaveLength(0);
    expect(await status()).toMatchObject({ source: null, configured: false, trackerSynced: false });

    // Still down: the removal stays pending.
    expect((await sync()).body).toMatchObject({ trackerSynced: false });
    expect(await db()`SELECT provider FROM ai_provider_key_removals`).toEqual([{ provider: 'anthropic' }]);

    tracker = 200;
    const retried = await sync();
    expect(retried.body).toMatchObject({ ok: true, trackerSynced: true });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'http://tracker.test/api/llm-keys/anthropic' });
    expect(await db()`SELECT 1 FROM ai_provider_key_removals`).toHaveLength(0);
    expect((await status()).trackerSynced).toBeNull();
    expect((await sync()).status).toBe(404);
  });

  it('a new save supersedes a pending removal', async () => {
    let tracker = 503;
    stubWithRowCheck(() => tracker);
    await put();
    await del();
    tracker = 200;
    await put();
    expect(await db()`SELECT 1 FROM ai_provider_key_removals`).toHaveLength(0);
    expect((await status()).trackerSynced).toBe(true);
  });

  it('re-pushes a saved key the tracker missed', async () => {
    let tracker = 503;
    const { calls } = stubWithRowCheck(() => tracker);
    expect((await put()).body).toMatchObject({ trackerSynced: false });
    expect((await status()).trackerSynced).toBe(false);
    tracker = 200;
    expect((await sync()).body).toEqual({ ok: true, trackerSynced: true });
    const push = calls.at(-1)!;
    expect(push.method).toBe('PUT');
    expect(JSON.parse(push.body!)).toEqual({ key: KEY });
    expect((await status()).trackerSynced).toBe(true);
  });

  it('refuses to remove a key a saved model still needs, unless an env key backs it', async () => {
    stubUpstreams();
    await put();
    await db()`
      INSERT INTO workspace_settings (key, value) VALUES
        ('ai_models', ${db().json({ default: 'anthropic:claude-sonnet-5-5', scan: 'anthropic:claude-sonnet-5-5' })}),
        ('po_ai_review', ${db().json({ enabled: true, model: 'anthropic:claude-sonnet-5-5' })})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    const r = await del();
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Settings ▸ AI models \(Default model, Label scan\)/);
    expect(r.body.error).toMatch(/AI review of purchase orders/);
    expect(await db()`SELECT 1 FROM ai_provider_keys`).toHaveLength(1);

    await db()`UPDATE workspace_settings SET value = ${db().json({ default: null })} WHERE key = 'ai_models'`;
    expect((await del()).status).toBe(409);

    expect((await del({ ...TRACKER, ANTHROPIC_API_KEY: 'env-key' })).status).toBe(200);
  });

  it('shows a saved key it cannot unseal as not configured', async () => {
    await db()`INSERT INTO ai_provider_keys (provider, sealed, last4, tracker_synced) VALUES ('anthropic', 'v1.a.b.c', 'abcd', TRUE)`;
    expect(await status()).toMatchObject({ source: 'ui', configured: false, unreadable: true });
    expect((await sync()).status).toBe(409);
  });
});

describe('PATCH /api/workspace key-checks every model it saves', () => {
  beforeEach(async () => {
    await resetDb();
    invalidateAiKeys();
  });

  it("refuses a PO review model whose provider has no key", async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ error: string }>('PATCH', '/api/workspace', {
      token, body: { po_ai_review: { enabled: true, model: 'anthropic:claude-sonnet-5-5' } },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/No Anthropic \(Claude\) API key/);
    const ok = await api('PATCH', '/api/workspace', {
      token, env: { ANTHROPIC_API_KEY: 'k' }, body: { po_ai_review: { enabled: true, model: 'anthropic:claude-sonnet-5-5' } },
    });
    expect(ok.status).toBe(200);
    expect((await api('PATCH', '/api/workspace', { token, body: { po_ai_review: { enabled: true, model: null } } })).status).toBe(200);
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
