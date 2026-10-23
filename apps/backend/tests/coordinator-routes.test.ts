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

  it('forwards one worker\'s login ledger, and an older console\'s 404 as it is', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubFacade(200, { logins: [{ id: 1, worker_id: 'ne-1', outcome: 'restored' }] });
    const r = await api<{ logins: unknown[] }>('GET', '/api/coordinator/workers/ne-1/logins', { token, env: ENV });
    expect(r.status).toBe(200);
    expect(r.body.logins).toHaveLength(1);
    expect((spy.mock.calls[0] as [string])[0]).toBe('http://facade.internal:8600/v1/logins?worker_id=ne-1&limit=500');

    stubFacade(404, { detail: 'Not Found' });
    expect((await api('GET', '/api/coordinator/workers/ne-1/logins', { token, env: ENV })).status).toBe(404);
    const bad = stubFacade(200, {});
    expect((await api('GET', '/api/coordinator/workers/a.b/logins', { token, env: ENV })).status).toBe(400);
    const marcus = (await loginAs(MARCUS)).token;
    expect((await api('GET', '/api/coordinator/workers/ne-1/logins', { token: marcus, env: ENV })).status).toBe(403);
    expect(bad).not.toHaveBeenCalled();
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


describe('Vault account writes (PUT /api/coordinator/accounts/:id)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires a manager', async () => {
    expect((await api('PUT', '/api/coordinator/accounts/ne-1', { body: {} })).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await api('PUT', '/api/coordinator/accounts/ne-1', { token, body: {} })).status).toBe(403);
  });

  it('forwards the write reduced to the allowed fields, and only presence flags come back', async () => {
    const { token } = await loginAs(ALEX);
    const upstreamAnswer = {
      account_id: 'ne-1', worker_id: 'ne-1', fb_username: 'lisa@example.com',
      allow_password_login: true, proxy_configured: false,
      secrets: { password: true, totp_secret: true, email: false },
    };
    const spy = stubFacade(200, upstreamAnswer);

    const r = await api<typeof upstreamAnswer>('PUT', '/api/coordinator/accounts/ne-1', {
      token, env: ENV,
      body: {
        worker_id: 'ne-1',
        fb_username: 'lisa@example.com',
        allow_password_login: true,
        proxy: 'http://user:pass@proxy.example:10002', // not settable from the ERP
        vnc_url: 'vnc://nope',
        secrets: { password: 's3cret-pw', totp_secret: 'JBSWY3DP', email: null, bogus: 'x', imap_port: 993 },
      },
    });

    expect(r.status).toBe(200);
    expect(r.body.secrets.password).toBe(true);
    expect(JSON.stringify(r.body)).not.toContain('s3cret-pw');

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://facade.internal:8600/v1/accounts/ne-1');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer console-secret');
    expect(JSON.parse(init.body as string)).toEqual({
      worker_id: 'ne-1',
      fb_username: 'lisa@example.com',
      allow_password_login: true,
      secrets: { password: 's3cret-pw', totp_secret: 'JBSWY3DP', email: null },
    });
  });

  it('refuses a bad id or body before anything is forwarded', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubFacade(200, {});
    expect((await api('PUT', '/api/coordinator/accounts/bad%20id', { token, env: ENV, body: {} })).status).toBe(400);
    expect((await api('PUT', '/api/coordinator/accounts/ne-1', { token, env: ENV, body: ['x'] })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('relays the coordinator refusal verbatim (a worker owned by another account)', async () => {
    const { token } = await loginAs(ALEX);
    stubFacade(409, { detail: "Worker 'homelab-1' already belongs to account 'personal'." });
    const r = await api<{ error: string }>('PUT', '/api/coordinator/accounts/spare', {
      token, env: ENV, body: { worker_id: 'homelab-1' },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already belongs to account 'personal'/);
  });
});

describe('Search settings (PUT /api/coordinator/settings)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires a manager', async () => {
    expect((await api('PUT', '/api/coordinator/settings', { body: {} })).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await api('PUT', '/api/coordinator/settings', { token, body: {} })).status).toBe(403);
  });

  it('forwards only the editable keys, signed by the session', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubFacade(200, { updated_at: '2026-10-17T10:00:00+00:00', updated_by: 'Alex', changed: ['homelab.toml'] });

    const r = await api<{ changed: string[] }>('PUT', '/api/coordinator/settings', {
      token, env: ENV,
      body: {
        search: { rating: 3, prompt: 'judge it', proxy_server: 'http://evil' },
        ai_model: 'openai/other',
        items: { server_ram: { keywords: ['ram'], description: 'nope' }, junk: 'x' },
        telegram_chat_id: '123',
        updated_by: 'someone else',
      },
    });

    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual(['homelab.toml']);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://facade.internal:8600/v1/config/settings');
    expect(init.method).toBe('PUT');
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      search: { rating: 3, prompt: 'judge it' },
      ai_model: 'openai/other',
      items: { server_ram: { keywords: ['ram'] } },
      updated_by: sent.updated_by,
    });
    expect(sent.updated_by).toBeTruthy();
    expect(sent.updated_by).not.toBe('someone else');
  });

  it('relays the facade’s validation message', async () => {
    const { token } = await loginAs(ALEX);
    stubFacade(400, { detail: 'rating must be a whole number from 1 to 5' });
    const r = await api<{ error: string }>('PUT', '/api/coordinator/settings', {
      token, env: ENV, body: { search: { rating: 7 } },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('rating must be a whole number from 1 to 5');
  });

  it('refuses a body that is not an object', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubFacade(200, {});
    expect((await api('PUT', '/api/coordinator/settings', { token, env: ENV, body: ['x'] })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Worker cities (PUT /api/coordinator/workers/:id/cities)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PATH = '/api/coordinator/workers/nyc-1/cities';

  it('requires a manager', async () => {
    expect((await api('PUT', PATH, { body: { cities: [] } })).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await api('PUT', PATH, { token, body: { cities: [] } })).status).toBe(403);
  });

  it('forwards each city narrowed to slug, name and radius, signed by the session', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubFacade(200, { worker_id: 'nyc-1', cities: [], changed: ['homelab-nyc.toml'] });
    const r = await api<{ changed: string[] }>('PUT', PATH, {
      token, env: ENV,
      body: {
        cities: [{ slug: 'longisland', name: 'Long Island, NY', radius: 60, proxy: 'http://evil' }],
        proxy_server: 'http://evil',
        updated_by: 'someone else',
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.changed).toEqual(['homelab-nyc.toml']);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://facade.internal:8600/v1/workers/nyc-1/cities');
    expect(init.method).toBe('PUT');
    const sent = JSON.parse(init.body as string);
    expect(sent.cities).toEqual([{ slug: 'longisland', name: 'Long Island, NY', radius: 60 }]);
    expect(Object.keys(sent).sort()).toEqual(['cities', 'updated_by']);
    expect(sent.updated_by).not.toBe('someone else');
  });

  it('relays the facade’s validation message and refuses a bad id or body', async () => {
    const { token } = await loginAs(ALEX);
    stubFacade(400, { detail: "'New York' is not a Marketplace location" });
    const r = await api<{ error: string }>('PUT', PATH, {
      token, env: ENV, body: { cities: [{ slug: 'New York', name: 'NY', radius: 60 }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not a Marketplace location/);

    const spy = stubFacade(200, {});
    expect((await api('PUT', '/api/coordinator/workers/a.b/cities', { token, env: ENV, body: { cities: [] } })).status).toBe(400);
    expect((await api('PUT', PATH, { token, env: ENV, body: { cities: 'nyc' } })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('City queue (PUT /api/coordinator/workers/:id/queue, /queue/everyone)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PATH = '/api/coordinator/workers/nyc-1/queue';

  it('requires a manager', async () => {
    expect((await api('PUT', PATH, { body: { enrolled: true } })).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await api('PUT', PATH, { token, body: { enrolled: true } })).status).toBe(403);
    expect((await api('PUT', '/api/coordinator/queue/everyone', { token, body: { enrolled: true } })).status).toBe(403);
  });

  it('forwards only the switch, signed by the session', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubFacade(200, { worker_id: 'nyc-1', enrolled: true, everyone: false });
    const r = await api<{ enrolled: boolean }>('PUT', PATH, {
      token, env: ENV, body: { enrolled: true, updated_by: 'someone else', worker_id: 'ne-1' },
    });
    expect(r.status).toBe(200);
    expect(r.body.enrolled).toBe(true);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://facade.internal:8600/v1/workers/nyc-1/queue');
    expect(init.method).toBe('PUT');
    const sent = JSON.parse(init.body as string);
    expect(Object.keys(sent).sort()).toEqual(['enrolled', 'updated_by']);
    expect(sent.enrolled).toBe(true);
    expect(sent.updated_by).not.toBe('someone else');

    const everyone = stubFacade(200, { settings: { enrolled: ['*'] } });
    expect((await api('PUT', '/api/coordinator/queue/everyone', { token, env: ENV, body: { enrolled: false } })).status).toBe(200);
    const [everyoneUrl, everyoneInit] = everyone.mock.calls[0] as [string, RequestInit];
    expect(everyoneUrl).toBe('http://facade.internal:8600/v1/queue/everyone');
    expect(JSON.parse(everyoneInit.body as string).enrolled).toBe(false);
  });

  it('relays the coordinator refusing an older worker, and refuses a bad id or body', async () => {
    const { token } = await loginAs(ALEX);
    stubFacade(409, { detail: 'ne-1 runs 0.13.12 (96d9204); the queue needs 0.13.14 or later. Redeploy this worker first.' });
    const r = await api<{ error: string }>('PUT', '/api/coordinator/workers/ne-1/queue', {
      token, env: ENV, body: { enrolled: true },
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Redeploy this worker first/);

    const spy = stubFacade(200, {});
    expect((await api('PUT', '/api/coordinator/workers/a.b/queue', { token, env: ENV, body: { enrolled: true } })).status).toBe(400);
    expect((await api('PUT', PATH, { token, env: ENV, body: { enrolled: 'yes' } })).status).toBe(400);
    expect((await api('PUT', '/api/coordinator/queue/everyone', { token, env: ENV, body: {} })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('City tiers (GET/PUT /api/coordinator/city-tiers)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PATH = '/api/coordinator/city-tiers';

  it('requires a manager', async () => {
    expect((await api('GET', PATH)).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await api('GET', PATH, { token })).status).toBe(403);
    expect((await api('PUT', PATH, { token, body: { pins: {} } })).status).toBe(403);
  });

  it('reads through, and forwards only the tier keys and pins, signed by the session', async () => {
    const { token } = await loginAs(ALEX);
    const spy = stubFacade(200, { settings: { top_pct: 20 }, pins: {} });
    expect((await api('GET', PATH, { token, env: ENV })).status).toBe(200);
    expect((spy.mock.calls[0] as [string])[0]).toBe('http://facade.internal:8600/v1/city-tiers');

    const r = await api('PUT', PATH, {
      token, env: ENV,
      body: {
        settings: { top_pct: 10, per_day: [4, 2, 1], start_at: ['00:00'] },
        pins: { denver: 3 },
        workers: { 'se-1': ['x'] },
        updated_by: 'someone else',
      },
    });
    expect(r.status).toBe(200);
    const [url, init] = spy.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('http://facade.internal:8600/v1/city-tiers');
    expect(init.method).toBe('PUT');
    const sent = JSON.parse(init.body as string);
    expect(sent.settings).toEqual({ top_pct: 10, per_day: [4, 2, 1] });
    expect(sent.pins).toEqual({ denver: 3 });
    expect(Object.keys(sent).sort()).toEqual(['pins', 'settings', 'updated_by']);
    expect(sent.updated_by).not.toBe('someone else');
  });

  it('relays the coordinator’s validation message and refuses an empty body', async () => {
    const { token } = await loginAs(ALEX);
    stubFacade(422, { detail: 'per_day must not grow from the busiest tier to the rest' });
    const r = await api<{ error: string }>('PUT', PATH, {
      token, env: ENV, body: { settings: { per_day: [1, 2, 3] } },
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/must not grow/);

    const spy = stubFacade(200, {});
    expect((await api('PUT', PATH, { token, env: ENV, body: { workers: {} } })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});
