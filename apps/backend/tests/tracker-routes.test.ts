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

  it('rejects paths outside the allowlist', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubTracker(200, {});

    const r = await api('GET', '/api/tracker/settings', { token, env: TRACKER_ENV });

    expect(r.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});
