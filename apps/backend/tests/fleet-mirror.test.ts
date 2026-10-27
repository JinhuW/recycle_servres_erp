import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { resetMirrorToken } from '../src/fleet/mirror';
import { sha256hex } from '../src/fleet/sql';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey, signAccessToken } from '../src/oauth/tokens';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import type { Env, OAuthScope } from '../src/types';

// FLEET_ROLE=mirror: the fleet runs on another ERP, this one holds a copy.
// Made-up material only.

const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const MIRROR: Partial<Env> = { FLEET_ROLE: 'mirror' };
const bearer = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-By': 'an-agent' });

describe('fleet mirror', () => {
  beforeEach(async () => {
    await resetDb();
    const db = getTestDb();
    await db`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 2, TRUE)`;
    await db`INSERT INTO fleet_cities (slug, name, enabled) VALUES ('houston', 'Houston', TRUE)`;
  });

  it('lets a manager read and says it is a mirror', async () => {
    const { token } = await loginAs(ALEX);
    const health = await api<{ mirror: boolean }>('GET', '/api/fleet/health', { token, env: MIRROR });
    expect(health.status).toBe(200);
    expect(health.body.mirror).toBe(true);
    const cities = await api<{ cities: Array<{ slug: string }> }>('GET', '/api/fleet/cities', { token, env: MIRROR });
    expect(cities.status).toBe(200);
    expect(cities.body.cities.map((c) => c.slug)).toEqual(['houston']);
    expect((await api('GET', '/api/fleet/hosts', { token, env: MIRROR })).status).toBe(200);
  });

  it('refuses every manager write with 409 read_only and changes nothing', async () => {
    const { token } = await loginAs(ALEX);
    const writes = [
      api('POST', '/api/fleet/cities', { token, env: MIRROR, body: { slug: 'austin', name: 'Austin' } }),
      api('PUT', '/api/fleet/cities/houston', { token, env: MIRROR, body: { enabled: false } }),
      api('DELETE', '/api/fleet/cities/houston', { token, env: MIRROR }),
      api('PUT', '/api/fleet/settings', { token, env: MIRROR, body: { familiar_days: 3 } }),
      api('POST', '/api/fleet/round/start', { token, env: MIRROR }),
      api('POST', '/api/fleet/hosts', { token, env: MIRROR, body: { host_id: 'other' } }),
      api('POST', '/api/fleet/workers/lab-1/relogin', { token, env: MIRROR }),
    ];
    for (const res of await Promise.all(writes)) {
      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toBe('read_only');
    }
    const db = getTestDb();
    expect(await db`SELECT slug, enabled FROM fleet_cities`).toEqual([{ slug: 'houston', enabled: true }]);
    expect((await db`SELECT host_id FROM fleet_hosts`).map((r) => r.host_id)).toEqual(['lab']);
  });

  // 401 and 409 make a worker exit, and its restart is a Facebook login.
  it('answers agents and workers 503, even with a valid host token', async () => {
    const calls = [
      api('GET', '/api/fleet/hosts/lab/desired', { headers: bearer(HOST_TOKEN), env: MIRROR }),
      api('POST', '/api/fleet/hosts/lab/report', { headers: bearer(HOST_TOKEN), env: MIRROR, body: { version: '1', containers: [] } }),
      api('POST', '/api/fleet/worker/claim', { headers: bearer(HOST_TOKEN), env: MIRROR, body: { worker_id: 'lab-1' } }),
      api('POST', '/api/fleet/worker/heartbeat', { headers: bearer('not-a-token'), env: MIRROR, body: {} }),
      api('POST', '/api/fleet/worker/next-task', { headers: bearer('not-a-token'), env: MIRROR, body: {} }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(503);
      expect((res.body as { error: string }).error).toBe('unavailable');
    }
    const [host] = await getTestDb()<{ last_seen_at: Date | null }[]>`SELECT last_seen_at FROM fleet_hosts`;
    expect(host.last_seen_at).toBeNull();
  });

  it('serves the fleet as before when the role is unset', async () => {
    const { token } = await loginAs(ALEX);
    const health = await api<{ mirror: boolean }>('GET', '/api/fleet/health', { token });
    expect(health.body.mirror).toBe(false);
    expect((await api('GET', '/api/fleet/hosts/lab/desired', { headers: bearer(HOST_TOKEN) })).status).toBe(200);
  });
});

// A mirror with FLEET_MIRROR_* reads the fleet it mirrors. Here "prod" is this
// same app without the mirror role, reached through a stubbed fetch, so the
// token grant and the fleet:read bearer run for real.
describe('fleet mirror reading prod live', () => {
  const PROD = 'https://prod.test';
  let clientId: string;
  let clientSecret: string;
  const LIVE = (): Partial<Env> => ({
    FLEET_ROLE: 'mirror', FLEET_MIRROR_URL: PROD,
    FLEET_MIRROR_CLIENT_ID: clientId, FLEET_MIRROR_CLIENT_SECRET: clientSecret,
  });
  let upstream: string[];
  let prodDown: boolean;

  beforeAll(async () => {
    process.env.__TEST_OAUTH_KEY__ = await generateSigningKey();
  });

  beforeEach(async () => {
    await resetDb();
    resetMirrorToken();
    const db = getTestDb();
    await db`INSERT INTO fleet_cities (slug, name, enabled) VALUES ('houston', 'Houston', TRUE)`;
    const [{ id: manager }] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const client = await createOAuthClient(db, {
      name: 'dev fleet mirror', redirectUris: [], grantTypes: ['client_credentials'], scopes: ['fleet:read'],
      createdBy: manager, public: false,
    });
    clientId = client.clientId;
    clientSecret = client.clientSecret!;
    upstream = [];
    prodDown = false;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(PROD)) return realFetch(input, init);
      if (prodDown) throw new TypeError('fetch failed');
      upstream.push(`${init?.method ?? 'GET'} ${url.slice(PROD.length)}`);
      return app.fetch(new Request(url.replace(PROD, 'http://localhost:8787'), init), testEnv);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('answers a manager read from prod, with one token across reads', async () => {
    const { token } = await loginAs(ALEX);
    // Only prod has Austin, so the answer can only have come from there.
    await getTestDb()`INSERT INTO fleet_cities (slug, name, enabled) VALUES ('austin', 'Austin', TRUE)`;
    const cities = await api<{ cities: Array<{ slug: string }> }>('GET', '/api/fleet/cities', { token, env: LIVE() });
    expect(cities.status).toBe(200);
    expect(cities.body.cities.map((c) => c.slug).sort()).toEqual(['austin', 'houston']);
    const tasks = await api('GET', '/api/fleet/tasks?city=houston', { token, env: LIVE() });
    expect(tasks.status).toBe(200);
    expect(upstream).toEqual(['POST /oauth/token', 'GET /api/fleet/cities', 'GET /api/fleet/tasks?city=houston']);
  });

  it('keeps health local and says the reads are live', async () => {
    const { token } = await loginAs(ALEX);
    const health = await api<{ mirror: boolean; mirror_live: boolean }>('GET', '/api/fleet/health', { token, env: LIVE() });
    expect(health.body).toMatchObject({ mirror: true, mirror_live: true });
    expect(upstream).toEqual([]);
  });

  it('checks the caller here before asking prod anything', async () => {
    expect((await api('GET', '/api/fleet/workers', { env: LIVE() })).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await api('GET', '/api/fleet/workers', { token, env: LIVE() })).status).toBe(403);
    expect(upstream).toEqual([]);
  });

  it('answers 502 when prod cannot be reached, never the stale copy', async () => {
    const { token } = await loginAs(ALEX);
    prodDown = true;
    const r = await api<{ error: string }>('GET', '/api/fleet/cities', { token, env: LIVE() });
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('mirror_unreachable');
  });

  it('still refuses writes and reads its copy without the variables', async () => {
    const { token } = await loginAs(ALEX);
    expect((await api('POST', '/api/fleet/cities', { token, env: LIVE(), body: { slug: 'austin', name: 'Austin' } })).status).toBe(409);
    const health = await api<{ mirror_live: boolean }>('GET', '/api/fleet/health', { token, env: MIRROR });
    expect(health.body.mirror_live).toBe(false);
    expect((await api('GET', '/api/fleet/cities', { token, env: MIRROR })).status).toBe(200);
    expect(upstream).toEqual([]);
  });
});

describe('fleet:read on the fleet the mirror reads', () => {
  let bearerFor: (scopes: OAuthScope[]) => Promise<string>;

  beforeAll(async () => {
    process.env.__TEST_OAUTH_KEY__ = await generateSigningKey();
  });

  beforeEach(async () => {
    await resetDb();
    const db = getTestDb();
    await db`INSERT INTO fleet_cities (slug, name, enabled) VALUES ('houston', 'Houston', TRUE)`;
    const [{ id: manager }] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX}`;
    const env = { OAUTH_ISSUER_URL: 'http://localhost:8787', OAUTH_SIGNING_KEY_CURRENT: process.env.__TEST_OAUTH_KEY__ } as never;
    bearerFor = async (scopes) => {
      const client = await createOAuthClient(db, {
        name: scopes.join(' '), redirectUris: [], grantTypes: ['client_credentials'], scopes, createdBy: manager, public: false,
      });
      return signAccessToken(env, { clientId: client.clientId, userId: null, scopes });
    };
  });

  it('reads with fleet:read, and nothing else', async () => {
    const read = await bearerFor(['fleet:read']);
    expect((await api('GET', '/api/fleet/workers', { headers: bearer(read) })).status).toBe(200);
    expect((await api('GET', '/api/fleet/hosts', { headers: bearer(read) })).status).toBe(200);
    const auth = { Authorization: `Bearer ${read}` };
    expect((await api('POST', '/api/fleet/cities', { headers: auth, body: { slug: 'austin', name: 'Austin' } })).status).toBe(401);
    expect((await api('GET', '/api/fleet/vnc/lab-1/ws', { headers: { ...bearer(read), Upgrade: 'websocket' } })).status).toBe(401);
    const market = await bearerFor(['market:read']);
    expect((await api('GET', '/api/fleet/workers', { headers: bearer(market) })).status).toBe(403);
  });
});
