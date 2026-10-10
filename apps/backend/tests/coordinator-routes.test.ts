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

  it('serves a raster screenshot under its own type, and anything else as a download', async () => {
    const { token } = await loginAs(ALEX);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const cases: Array<[string | null, string]> = [
      ['image/jpeg', 'image/jpeg'],
      ['image/webp; charset=binary', 'image/webp'],
      ['text/html', 'application/octet-stream'],
      ['image/svg+xml', 'application/octet-stream'],
    ];
    for (const [upstreamType, served] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, {
        status: 200,
        headers: upstreamType ? { 'Content-Type': upstreamType } : {},
      })));
      const r = await api('GET', '/api/coordinator/challenges/c-1/screenshot', { token, env: ENV });
      expect(r.status).toBe(200);
      expect(r.headers.get('Content-Type')).toBe(served);
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });

  it('passes an upstream failure status through', async () => {
    const { token } = await loginAs(ALEX);
    stubFacade(502, { detail: 'Coordinator is unreachable' });
    const r = await api<{ detail: string }>('GET', '/api/coordinator/fleet', { token, env: ENV });
    expect(r.status).toBe(502);
    expect(r.body.detail).toMatch(/unreachable/);
  });

  it('surfaces a FastAPI {detail} as the error the SPA shows', async () => {
    const { token } = await loginAs(ALEX);
    stubFacade(409, { detail: 'A re-login is already queued' });
    const r = await api<{ error: string }>('POST', '/api/coordinator/workers/ne-1/relogin', { token, env: ENV });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('A re-login is already queued');
  });

  it('blames the console’s own token, not ours, for a coordinator 401 it relays', async () => {
    const { token } = await loginAs(ALEX);
    stubFacade(401, { detail: 'Invalid or missing admin token' });
    const r = await api<{ error: string }>('GET', '/api/coordinator/fleet', { token, env: ENV });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/RS_COORDINATOR_ADMIN_TOKEN/);
    expect(r.body.error).not.toMatch(/COORDINATOR_API_TOKEN/);
  });

  it('queues a worker re-login upstream', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubFacade(200, { status: 'queued' });

    const r = await api('POST', '/api/coordinator/workers/ne-1/relogin', { token, env: ENV });

    expect(r.status).toBe(200);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://facade.internal:8600/v1/workers/ne-1/relogin');
    expect(init.method).toBe('POST');
  });

  it('refuses a re-login from a purchaser', async () => {
    const { token } = await loginAs(MARCUS);
    const spy = stubFacade(200, {});
    const r = await api('POST', '/api/coordinator/workers/ne-1/relogin', { token, env: ENV });
    expect(r.status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  describe('VNC socket admission (GET /vnc/:workerId/ws)', () => {
    const UPGRADE = { Upgrade: 'websocket', Origin: 'http://localhost:5173' };

    it('admits a manager from an allowed origin with a 204', async () => {
      const { token } = await loginAs(ALEX);
      const r = await api('GET', '/api/coordinator/vnc/ne-1/ws', { token, env: ENV, headers: UPGRADE });
      expect(r.status).toBe(204);
    });

    it('needs a session and a manager before anything else', async () => {
      expect((await api('GET', '/api/coordinator/vnc/ne-1/ws', { env: ENV, headers: UPGRADE })).status).toBe(401);
      const { token } = await loginAs(MARCUS);
      expect((await api('GET', '/api/coordinator/vnc/ne-1/ws', { token, env: ENV, headers: UPGRADE })).status).toBe(403);
    });

    it('refuses a foreign page even with a valid session cookie', async () => {
      const { token } = await loginAs(ALEX);
      const env = { ...ENV, CORS_ALLOWED_ORIGINS: 'https://inventory.recycleservers.com' };
      const foreign = await api('GET', '/api/coordinator/vnc/ne-1/ws', {
        token, env, headers: { Upgrade: 'websocket', Origin: 'https://recycleservers.com' },
      });
      expect(foreign.status).toBe(403);
      const missing = await api('GET', '/api/coordinator/vnc/ne-1/ws', {
        token, env, headers: { Upgrade: 'websocket' },
      });
      expect(missing.status).toBe(403);
      const own = await api('GET', '/api/coordinator/vnc/ne-1/ws', {
        token, env, headers: { Upgrade: 'websocket', Origin: 'https://inventory.recycleservers.com' },
      });
      expect(own.status).toBe(204);
    });

    it('admits the app origin when the configured one ends in a slash', async () => {
      const { token } = await loginAs(ALEX);
      const env = { ...ENV, CORS_ALLOWED_ORIGINS: 'https://inventory.recycleservers.com/' };
      const own = await api('GET', '/api/coordinator/vnc/ne-1/ws', {
        token, env, headers: { Upgrade: 'websocket', Origin: 'https://inventory.recycleservers.com' },
      });
      expect(own.status).toBe(204);
    });

    it('is not a socket without an Upgrade header', async () => {
      const { token } = await loginAs(ALEX);
      const r = await api('GET', '/api/coordinator/vnc/ne-1/ws', {
        token, env: ENV, headers: { Origin: 'http://localhost:5173' },
      });
      expect(r.status).toBe(426);
    });

    it('rejects a worker id outside the fleet naming rule, and an unconfigured proxy', async () => {
      const { token } = await loginAs(ALEX);
      const bad = await api('GET', '/api/coordinator/vnc/..%2Fadmin/ws', { token, env: ENV, headers: UPGRADE });
      expect(bad.status).toBe(404);
      const unconfigured = await api('GET', '/api/coordinator/vnc/ne-1/ws', { token, headers: UPGRADE });
      expect(unconfigured.status).toBe(501);
    });
  });

  it('never passes the facade refusing our token through as a 401 the SPA reads as a lapsed session', async () => {
    const { token } = await loginAs(ALEX);
    const paths = ['/api/coordinator/fleet', '/api/coordinator/challenges?status=open', '/api/coordinator/challenges/7/screenshot'];
    // A 401, a bare 403, and Cloudflare Access's HTML 403 page all mean our
    // credentials.
    const refusals: [string, () => Response][] = [
      ['401', () => new Response(JSON.stringify({ detail: 'Invalid bearer token' }), { status: 401 })],
      ['bare 403', () => new Response(null, { status: 403 })],
      ['Access 403', () => new Response('<!doctype html><title>Forbidden</title>', { status: 403, headers: { 'Content-Type': 'text/html' } })],
    ];
    for (const [label, make] of refusals) {
      vi.stubGlobal('fetch', vi.fn(async () => make()));
      for (const path of paths) {
        const r = await api<{ error: string }>('GET', path, { token, env: ENV });
        expect(r.status, `${path} on upstream ${label}`).toBe(502);
        expect(r.body.error).toMatch(/COORDINATOR_API_TOKEN/);
      }
    }
    // A refused write is the same misconfiguration.
    stubFacade(401, { detail: 'Invalid bearer token' });
    expect((await api('POST', '/api/coordinator/workers/ne-1/relogin', { token, env: ENV })).status).toBe(502);
  });

  it('keeps the facade’s own words when it explains a 403, still never as a 403', async () => {
    const { token } = await loginAs(ALEX);
    stubFacade(403, { detail: 'Re-login is not allowed for this worker' });
    const relogin = await api<{ error: string }>('POST', '/api/coordinator/workers/ne-1/relogin', { token, env: ENV });
    expect(relogin.status).toBe(502);
    expect(relogin.body.error).toBe('The fleet console refused this request: Re-login is not allowed for this worker');
    const shot = await api<{ error: string }>('GET', '/api/coordinator/challenges/7/screenshot', { token, env: ENV });
    expect(shot.status).toBe(502);
    expect(shot.body.error).not.toMatch(/COORDINATOR_API_TOKEN/);
  });
});

