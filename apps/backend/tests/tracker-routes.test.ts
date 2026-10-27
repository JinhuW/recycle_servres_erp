import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// Stub the upstream tracker API the same way fx-routes.test.ts stubs
// Frankfurter — vi.stubGlobal on fetch (no undici MockAgent in this repo).
function stubTracker(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const TRACKER_ENV = {
  TRACKER_API_URL: 'http://tracker.internal:8080',
  TRACKER_API_TOKEN: 'tracker-secret',
};

describe('Tracker proxy routes (/api/tracker)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires a session (401 without auth)', async () => {
    const r = await api('GET', '/api/tracker/workers');
    expect(r.status).toBe(401);
  });

  it('non-manager (purchaser) is forbidden', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('GET', '/api/tracker/workers', { token });
    expect(r.status).toBe(403);
  });

  it('reports 501 when the tracker env vars are not configured', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ error: string }>('GET', '/api/tracker/workers', { token });
    expect(r.status).toBe(501);
    expect(r.body.error).toMatch(/not configured/i);
  });

  it('forwards a GET with the bearer token and passes the body through', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubTracker(200, { workers: [{ workerId: 'w-1', role: 'worker' }] });

    const r = await api<{ workers: Array<{ workerId: string }> }>(
      'GET', '/api/tracker/workers', { token, env: TRACKER_ENV },
    );

    expect(r.status).toBe(200);
    expect(r.body.workers[0]?.workerId).toBe('w-1');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://tracker.internal:8080/api/workers');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tracker-secret');
  });

  it('forwards the query string on worker listings', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubTracker(200, { workers: [], total: 0 });

    const r = await api('GET', '/api/tracker/workers?status=live&limit=15&offset=30', {
      token,
      env: TRACKER_ENV,
    });

    expect(r.status).toBe(200);
    const [url] = spy.mock.calls[0] as [string];
    expect(url).toBe('http://tracker.internal:8080/api/workers?status=live&limit=15&offset=30');
  });

  it('forwards the matches listing with its query and the stats read', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubTracker(200, { count: 1, matches: [{ redditId: 't3_abc', status: 'notified' }] });

    const m = await api<{ matches: Array<{ redditId: string }> }>(
      'GET', '/api/tracker/matches?limit=8&since=2026-10-01T00:00:00Z', { token, env: TRACKER_ENV },
    );
    expect(m.status).toBe(200);
    expect(m.body.matches[0]?.redditId).toBe('t3_abc');
    expect((spy.mock.calls[0] as [string])[0])
      .toBe('http://tracker.internal:8080/api/matches?limit=8&since=2026-10-01T00:00:00Z');

    const stats = { posts: { new: 2, rejected: 40, notified: 3 }, oldestPending: null, subreddits: [], failed: [] };
    const statsSpy = stubTracker(200, stats);
    const s = await api<typeof stats>(
      'GET', '/api/tracker/stats?since=2026-10-17T00:00:00Z', { token, env: TRACKER_ENV },
    );
    expect(s.status).toBe(200);
    expect(s.body).toEqual(stats);
    expect((statsSpy.mock.calls[0] as [string])[0])
      .toBe('http://tracker.internal:8080/api/stats?since=2026-10-17T00:00:00Z');
  });

  it('forwards the analytics read with its window, to managers only', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubTracker(200, { window: '30d', volume: { alerts: 4 } });

    const r = await api<{ window: string }>('GET', '/api/tracker/analytics?window=30d', { token, env: TRACKER_ENV });
    expect(r.status).toBe(200);
    expect(r.body.window).toBe('30d');
    expect((spy.mock.calls[0] as [string])[0]).toBe('http://tracker.internal:8080/api/analytics?window=30d');

    const purchaser = await loginAs(MARCUS);
    const denied = await api('GET', '/api/tracker/analytics?window=7d', { token: purchaser.token, env: TRACKER_ENV });
    expect(denied.status).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('forwards the seen read, to managers only', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubTracker(200, { userSenderLive: true, alerts: [], people: [] });

    const r = await api<{ userSenderLive: boolean }>('GET', '/api/tracker/seen', { token, env: TRACKER_ENV });
    expect(r.status).toBe(200);
    expect(r.body.userSenderLive).toBe(true);
    expect((spy.mock.calls[0] as [string])[0]).toBe('http://tracker.internal:8080/api/seen');

    const purchaser = await loginAs(MARCUS);
    const denied = await api('GET', '/api/tracker/seen', { token: purchaser.token, env: TRACKER_ENV });
    expect(denied.status).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('forwards the prompt trial routes: stats with their window, start, end and promote', async () => {
    const { token } = await loginAs(ALEX);
    const calls: Array<[string, string | undefined, string | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init.method, init.body as string | undefined]);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    const opts = { token, env: TRACKER_ENV };
    expect((await api('GET', '/api/tracker/prompt-stats?since=2026-10-12T00:00:00Z', opts)).status).toBe(200);
    expect((await api('PUT', '/api/tracker/prompt-candidate', {
      ...opts, body: { prompt: 'Judge bulk lots only.', model: '' },
    })).status).toBe(200);
    expect((await api('DELETE', '/api/tracker/prompt-candidate', opts)).status).toBe(200);
    expect((await api('POST', '/api/tracker/prompt-candidate/promote', opts)).status).toBe(200);

    expect(calls.map(([url, method]) => [url, method])).toEqual([
      ['http://tracker.internal:8080/api/prompt-stats?since=2026-10-12T00:00:00Z', 'GET'],
      ['http://tracker.internal:8080/api/prompt-candidate', 'PUT'],
      ['http://tracker.internal:8080/api/prompt-candidate', 'DELETE'],
      ['http://tracker.internal:8080/api/prompt-candidate/promote', 'POST'],
    ]);
    expect(JSON.parse(calls[1]![2]!)).toEqual({ prompt: 'Judge bulk lots only.', model: '' });
  });

  it('keeps prompt trials manager-only', async () => {
    const { token } = await loginAs(MARCUS);
    const spy = stubTracker(200, {});

    const r = await api('PUT', '/api/tracker/prompt-candidate', {
      token, env: TRACKER_ENV, body: { prompt: 'x' },
    });

    expect(r.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('forwards a POST body and preserves the upstream status', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubTracker(201, { rule: { id: 1, name: 'EPYC lots' } });

    const r = await api<{ rule: { id: number } }>('POST', '/api/tracker/rules', {
      token,
      env: TRACKER_ENV,
      body: { name: 'EPYC lots', prompt: 'Alert on bulk EPYC CPU lots.' },
    });

    expect(r.status).toBe(201);
    expect(r.body.rule.id).toBe(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://tracker.internal:8080/api/rules');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ name: 'EPYC lots' });
  });

  it('passes upstream errors through instead of masking them', async () => {
    const { token } = await loginAs(ALEX);
    stubTracker(400, { error: 'name must be a subreddit name without the r/ prefix' });

    const r = await api<{ error: string }>('POST', '/api/tracker/subreddits', {
      token,
      env: TRACKER_ENV,
      body: { name: '!!!' },
    });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/subreddit name/);
  });

  it('forwards path params on PATCH and DELETE', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubTracker(200, { subreddit: { name: 'homelab', enabled: false } });

    const r = await api('PATCH', '/api/tracker/subreddits/homelab', {
      token,
      env: TRACKER_ENV,
      body: { enabled: false },
    });

    expect(r.status).toBe(200);
    const [url] = spy.mock.calls[0] as [string];
    expect(url).toBe('http://tracker.internal:8080/api/subreddits/homelab');
  });

  it('relays a bodiless upstream status without a body', async () => {
    const { token } = await loginAs(ALEX);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    const r = await api('DELETE', '/api/tracker/rules/7', { token, env: TRACKER_ENV });

    expect(r.status).toBe(204);
    expect(r.body).toBeUndefined();
  });

  it('answers 502 when the tracker is unreachable', async () => {
    const { token } = await loginAs(ALEX);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed');
    }));

    const r = await api<{ error: string }>('GET', '/api/tracker/workers', {
      token,
      env: TRACKER_ENV,
    });

    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/unreachable/i);
  });

  it('rejects paths outside the allowlist, settings keys other than the live model included', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubTracker(200, {});
    const opts = { token, env: TRACKER_ENV };

    expect((await api('GET', '/api/tracker/settings', opts)).status).toBe(404);
    expect((await api('GET', '/api/tracker/settings/llm_model', opts)).status).toBe(404);
    expect((await api('PUT', '/api/tracker/settings/eval_prompt', { ...opts, body: { value: 'x' } })).status)
      .toBe(404);
    expect((await api('PUT', '/api/tracker/settings/telegram_chat_ids', { ...opts, body: { value: [] } })).status)
      .toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('forwards the live model setting by key and relays what the tracker stored', async () => {
    const { token } = await loginAs(ALEX);
    const calls: Array<[string, string | undefined, string | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init.method, init.body as string | undefined]);
      return new Response(JSON.stringify({ key: 'llm_model', value: 'anthropic/claude-haiku-5.5' }), { status: 200 });
    }));

    const r = await api<{ key: string; value: string }>('PUT', '/api/tracker/settings/llm_model', {
      token, env: TRACKER_ENV, body: { value: 'anthropic/claude-haiku-5.5' },
    });

    expect(r.status).toBe(200);
    expect(r.body).toEqual({ key: 'llm_model', value: 'anthropic/claude-haiku-5.5' });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('http://tracker.internal:8080/api/settings/llm_model');
    expect(calls[0]![1]).toBe('PUT');
    expect(JSON.parse(calls[0]![2]!)).toEqual({ value: 'anthropic/claude-haiku-5.5' });
  });

  it('keeps the live model setting manager-only', async () => {
    const { token } = await loginAs(MARCUS);
    const spy = stubTracker(200, {});

    const r = await api('PUT', '/api/tracker/settings/llm_model', {
      token, env: TRACKER_ENV, body: { value: 'openai/gpt-4o-mini' },
    });

    expect(r.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });
  it('never passes the tracker refusing our token through as a 401 the SPA reads as a lapsed session', async () => {
    const { token } = await loginAs(ALEX);
    for (const status of [401, 403]) {
      stubTracker(status, { error: 'unauthorized' });
      const r = await api<{ error: string }>('GET', '/api/tracker/workers', { token, env: TRACKER_ENV });
      expect(r.status, `upstream ${status}`).toBe(502);
      expect(r.body.error).toMatch(/TRACKER_API_TOKEN/);
    }
    stubTracker(401, {});
    expect((await api('POST', '/api/tracker/rules', { token, env: TRACKER_ENV, body: {} })).status).toBe(502);
  });
});
