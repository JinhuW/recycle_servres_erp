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

  describe('account pool (/accounts)', () => {
    const sent = (spy: ReturnType<typeof stubFacade>) => {
      const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
      return { url, method: init.method, body: JSON.parse(init.body as string) as unknown };
    };

    it('keeps purchasers out without asking upstream', async () => {
      const { token } = await loginAs(MARCUS);
      const spy = stubFacade(200, {});
      expect((await api('GET', '/api/coordinator/accounts', { token, env: ENV })).status).toBe(403);
      expect((await api('POST', '/api/coordinator/accounts', { token, env: ENV, body: { account_id: 'a1' } })).status).toBe(403);
      expect((await api('PATCH', '/api/coordinator/accounts/a1', { token, env: ENV, body: {} })).status).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    });

    it('reports 501 when the control plane is not configured', async () => {
      const { token } = await loginAs(ALEX);
      expect((await api('GET', '/api/coordinator/accounts', { token })).status).toBe(501);
    });

    it('lists the vault accounts with the bearer token', async () => {
      const { token } = await loginAs(ALEX);
      const spy = stubFacade(200, { accounts: [{ account_id: 'fb-1', worker_id: null }] });

      const r = await api<{ accounts: Array<{ account_id: string }> }>(
        'GET', '/api/coordinator/accounts', { token, env: ENV },
      );

      expect(r.status).toBe(200);
      expect(r.body.accounts[0]?.account_id).toBe('fb-1');
      const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://facade.internal:8600/v1/accounts');
      expect(init.method).toBe('GET');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer console-secret');
    });

    it('creates from a rebuilt body signed by the session user', async () => {
      const { token } = await loginAs(ALEX);
      const spy = stubFacade(201, { account_id: 'fb-1' });

      const r = await api('POST', '/api/coordinator/accounts', {
        token, env: ENV, body: {
          account_id: 'fb-1',
          fb_username: 'ops@example.com',
          worker_id: null,
          region: 'denver',
          secrets: { password: 'hunter2', imap_port: null, recovery_codes: 'x' },
          changed_by: 'mallory',
          allow_password_login: true,
          proxy: 'socks5://evil',
        },
      });

      expect(r.status).toBe(201);
      expect(sent(spy)).toEqual({
        url: 'http://facade.internal:8600/v1/accounts',
        method: 'POST',
        body: {
          account_id: 'fb-1',
          fb_username: 'ops@example.com',
          worker_id: null,
          region: 'denver',
          secrets: { password: 'hunter2', imap_port: null },
          changed_by: 'Alex Chen',
        },
      });
    });

    it('edits only the fields sent, keeping nulls, under the session user', async () => {
      const { token } = await loginAs(ALEX);
      const spy = stubFacade(200, { account_id: 'ops@fb.1' });

      const r = await api('PATCH', '/api/coordinator/accounts/ops@fb.1', {
        token, env: ENV, body: {
          worker_id: null,
          secrets: { email: null, email_password: 'pw', session_cookie: 'x' },
          account_id: 'someone-else',
          changed_by: 'mallory',
        },
      });

      expect(r.status).toBe(200);
      expect(sent(spy)).toEqual({
        url: 'http://facade.internal:8600/v1/accounts/ops%40fb.1',
        method: 'PATCH',
        body: {
          worker_id: null,
          secrets: { email: null, email_password: 'pw' },
          changed_by: 'Alex Chen',
        },
      });
    });

    it('refuses a bad id or body without asking upstream', async () => {
      const { token } = await loginAs(ALEX);
      const spy = stubFacade(200, {});
      const cases: Array<['POST' | 'PATCH', string, unknown]> = [
        ['PATCH', '/api/coordinator/accounts/..%2Fadmin', {}],
        ['PATCH', '/api/coordinator/accounts/-leading-dash', {}],
        ['POST', '/api/coordinator/accounts', { fb_username: 'no id' }],
        ['POST', '/api/coordinator/accounts', { account_id: 'has space' }],
        ['POST', '/api/coordinator/accounts', 'not an object'],
        ['PATCH', '/api/coordinator/accounts/fb-1', ['not', 'an', 'object']],
        ['PATCH', '/api/coordinator/accounts/fb-1', { region: 7 }],
        ['PATCH', '/api/coordinator/accounts/fb-1', { secrets: 'hunter2' }],
        ['PATCH', '/api/coordinator/accounts/fb-1', { secrets: { password: 42 } }],
      ];
      for (const [method, path, body] of cases) {
        const r = await api<{ error: string }>(method, path, { token, env: ENV, body });
        expect(r.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
        expect(typeof r.body.error).toBe('string');
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it('shows the coordinator’s reason for a refused write as the error', async () => {
      const { token } = await loginAs(ALEX);
      stubFacade(409, { detail: 'worker ne-1 is held by fb-2' });
      const held = await api<{ error: string }>('PATCH', '/api/coordinator/accounts/fb-1', {
        token, env: ENV, body: { worker_id: 'ne-1' },
      });
      expect(held.status).toBe(409);
      expect(held.body).toEqual({ error: 'worker ne-1 is held by fb-2' });

      // A schema miss is a list of field errors, which may echo the value.
      stubFacade(422, { detail: [{ loc: ['body', 'secrets', 'imap_port'], msg: 'bad', input: 'hunter2' }] });
      const schema = await api<{ error: string }>('POST', '/api/coordinator/accounts', {
        token, env: ENV, body: { account_id: 'fb-1' },
      });
      expect(schema.status).toBe(422);
      expect(schema.body).toEqual({ error: 'Invalid account data' });
    });

    it('turns the facade refusing our token into a 502', async () => {
      const { token } = await loginAs(ALEX);
      stubFacade(401, { detail: 'Invalid bearer token' });
      const list = await api<{ error: string }>('GET', '/api/coordinator/accounts', { token, env: ENV });
      expect(list.status).toBe(502);
      expect(list.body.error).toMatch(/COORDINATOR_API_TOKEN/);
      const edit = await api('PATCH', '/api/coordinator/accounts/fb-1', { token, env: ENV, body: { region: 'x' } });
      expect(edit.status).toBe(502);
    });

    it('leaves the other routes’ refusals as the coordinator wrote them', async () => {
      const { token } = await loginAs(ALEX);
      stubFacade(409, { detail: 'already resolved' });
      const r = await api<{ detail: string }>('POST', '/api/coordinator/challenges/7/resolve', { token, env: ENV });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ detail: 'already resolved' });
    });
  });

  it('never passes the facade refusing our token through as a 401 the SPA reads as a lapsed session', async () => {
    const { token } = await loginAs(ALEX);
    for (const status of [401, 403]) {
      stubFacade(status, { detail: 'Invalid bearer token' });
      for (const path of ['/api/coordinator/fleet', '/api/coordinator/challenges?status=open', '/api/coordinator/challenges/7/screenshot']) {
        const r = await api<{ error: string }>('GET', path, { token, env: ENV });
        expect(r.status, `${path} on upstream ${status}`).toBe(502);
        expect(r.body.error).toMatch(/COORDINATOR_API_TOKEN/);
      }
    }
    // A refused write is the same misconfiguration.
    stubFacade(401, { detail: 'Invalid bearer token' });
    expect((await api('POST', '/api/coordinator/workers/ne-1/relogin', { token, env: ENV })).status).toBe(502);
  });
});

