import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256hex } from '../src/fleet/sql';
import { getTestDb, resetDb } from './helpers/db';
import { api } from './helpers/app';
import { ALEX, loginAs } from './helpers/auth';
import type { Env } from '../src/types';

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
