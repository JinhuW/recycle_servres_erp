import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';

// Same fetch stub as tracker-routes.test.ts: the facade is upstream, and the
// only things worth asserting are the URL, the bearer header and pass-through.
function stubFacade(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ENV = {
  COORDINATOR_API_URL: 'http://facade.internal:8600/',
  COORDINATOR_API_TOKEN: 'console-secret',
};

describe('Coordinator proxy routes (/api/coordinator)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires a session and a manager', async () => {
    expect((await api('GET', '/api/coordinator/fleet')).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await api('GET', '/api/coordinator/fleet', { token })).status).toBe(403);
  });

  it('reports 501 when the control plane is not configured', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api<{ error: string }>('GET', '/api/coordinator/fleet', { token });
    expect(r.status).toBe(501);
    expect(r.body.error).toMatch(/not configured/i);
  });

  it('forwards the fleet view with the bearer token', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubFacade(200, { workers: [{ worker_id: 'homelab-1' }], regions: [] });

    const r = await api<{ workers: Array<{ worker_id: string }> }>(
      'GET', '/api/coordinator/fleet', { token, env: ENV },
    );

    expect(r.status).toBe(200);
    expect(r.body.workers[0]?.worker_id).toBe('homelab-1');
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://facade.internal:8600/v1/fleet');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer console-secret');
  });

  it('forwards the alert-hit window untouched', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubFacade(200, { rows: [], unmatched_reactions: 0 });

    const r = await api('GET', '/api/coordinator/stats/alert-hits?days=7', { token, env: ENV });

    expect(r.status).toBe(200);
    const [url] = spy.mock.calls[0] as [string];
    expect(url).toBe('http://facade.internal:8600/v1/stats/alert-hits?days=7');
  });

  it('passes an upstream failure status through', async () => {
    const { token } = await loginAs(ALEX);
    stubFacade(502, { detail: 'Coordinator is unreachable' });
    const r = await api<{ detail: string }>('GET', '/api/coordinator/fleet', { token, env: ENV });
    expect(r.status).toBe(502);
    expect(r.body.detail).toMatch(/unreachable/);
  });
});
