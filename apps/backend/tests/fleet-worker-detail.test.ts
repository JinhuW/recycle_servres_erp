import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { ClaimAnswer, FleetWorkerDetail, NextTaskAnswer } from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { sha256hex } from '../src/fleet/sql';
import { poolKey, seal } from '../src/lib/sealed';

// GET /api/fleet/workers/:id, the worker page's one read. Every account, host,
// proxy and secret here is made up.

const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const PROXY_LOGIN = 'proxy-user-' + randomBytes(4).toString('hex');
const PROXY_PASS = 'proxy-pass-' + randomBytes(8).toString('hex');
const FB_PASSWORD = 'fb-pw-' + randomBytes(8).toString('hex');
const key = () => poolKey(testEnv)!;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let manager: string;

async function seed(): Promise<{ no: number; proxyId: number }> {
  const db = getTestDb();
  const k = key();
  await db`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 2, TRUE)`;
  await db`INSERT INTO fleet_items (name, phrases, filters) VALUES ('server_ram', '["server ram"]', '{}'), ('enterprise_ssd', '["ssd"]', '{}')`;
  await db`INSERT INTO fleet_cities (slug, name, enabled) VALUES ('houston', 'Houston', TRUE), ('denver', 'Denver', TRUE), ('nyc', 'New York', TRUE)`;
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, email, password_enc, totp_enc, cookie_enc, cookie_uid, cookie_at)
    VALUES ('61550000000001', 'fixtures', 'available', 'acct1@example.test', ${seal(FB_PASSWORD, k)}, ${seal('ABCD EFGH', k)},
            ${seal('c_user=61550000000001; xs=secret-xs', k)}, '61550000000001', NOW() - INTERVAL '2 hours')
    RETURNING no`;
  const proxy = await api<{ id: number }>('POST', '/api/fleet/proxies', {
    token: manager, body: { label: 'NY 1', url: `http://${PROXY_LOGIN}:${PROXY_PASS}@isp.example.net:10001`, timezone: 'America/New_York' },
  });
  expect(proxy.status).toBe(201);
  const slot = await api('POST', '/api/fleet/slots', { token: manager, body: { account_no: a.no, proxy_id: proxy.body.id, home_cities: ['nyc'] } });
  expect(slot.status).toBe(201);
  return { no: a.no, proxyId: proxy.body.id };
}

async function claim(workerId: string): Promise<ClaimAnswer> {
  const r = await api<ClaimAnswer>('POST', '/api/fleet/worker/claim', {
    headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id: workerId, version: '0.14.7', vnc_port: 5901 },
  });
  expect(r.status).toBe(200);
  return r.body;
}

const nextTask = (token: string, done: unknown = null) =>
  api<NextTaskAnswer>('POST', '/api/fleet/worker/next-task', { headers: bearer(token), body: { done, wait: 0 } });

const detail = (id: string, token = manager) => api<FleetWorkerDetail & { error?: string }>('GET', `/api/fleet/workers/${id}`, { token });

beforeEach(async () => {
  await resetDb();
  manager = (await loginAs(ALEX)).token;
});

describe('GET /api/fleet/workers/:id', () => {
  it('answers the worker, its slot, account, proxy, cities, stats and history without a secret', async () => {
    const { no, proxyId } = await seed();
    const db = getTestDb();
    const claimed = await claim('lab-1');
    const token = claimed.worker_token;
    await api('POST', '/api/fleet/worker/heartbeat', {
      headers: bearer(token),
      body: { state: 'HEALTHY', version: '0.14.7', vnc_port: 5901, detail: { session_expiry: '2026-12-01T00:00:00Z', browser_ok: true } },
    });

    // One search finished with two alerts, one stopped at a wall.
    await db`INSERT INTO fleet_tasks (city, item, due_at, state, reason) VALUES ('houston', 'server_ram', NOW(), 'ready', 'cadence')`;
    const first = await nextTask(token);
    const firstId = (first.body as { task: { id: number } }).task.id;
    await db`INSERT INTO fleet_tasks (city, item, due_at, state, reason) VALUES ('denver', 'server_ram', NOW(), 'ready', 'cadence')`;
    const second = await nextTask(token, { task_id: firstId, result: { cards: 80, opened: 5, reviewed: 5, alerted: 2, seconds: 300 } });
    const secondId = (second.body as { task: { id: number } }).task.id;
    await api('POST', '/api/fleet/worker/events', {
      headers: bearer(token), body: { task_id: secondId, kind: 'stopped', detail: { reason: 'wall', wall: 'checkpoint' } },
    });

    const r = await detail('lab-1');
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.worker).toMatchObject({ worker_id: 'lab-1', host_id: 'lab', state: 'HEALTHY', version: '0.14.7', account_no: no });
    expect(d.worker.detail).toMatchObject({ session_expiry: '2026-12-01T00:00:00Z', browser_ok: true });
    expect(d.worker.task).toMatchObject({ id: secondId, city: 'denver', city_name: 'Denver' });
    expect(d.holds_slot).toBe(true);
    expect(d.slot).toMatchObject({ account_no: no, worker_id: 'lab-1', proxy_id: proxyId, home_cities: ['nyc'], parked: false });
    expect(d.proxy).toEqual({ id: proxyId, label: 'NY 1', host: 'isp.example.net', port: 10001, timezone: 'America/New_York' });
    expect(d.account).toMatchObject({ no, uid: '61550000000001', email: 'acct1@example.test', status: 'fleet', holder: 'lab-1' });
    expect(d.account!.secrets).toEqual(['password', 'totp', 'cookie']);
    expect(d.account!.cookie_at).not.toBeNull();
    expect(d.stats).toMatchObject({ days: 7, searches: 1, alerts: 2, errors: 1 });
    expect(d.stats.last_search_at).not.toBeNull();
    // Home first, then the cities it searched; a home city never searched has no date.
    expect(d.cities.map((c) => [c.slug, c.home])).toEqual([['nyc', true], ['houston', false], ['denver', false]]);
    expect(d.cities.find((c) => c.slug === 'houston')).toMatchObject({ name: 'Houston', alerts: 2 });
    expect(d.cities[0].last_done_at).toBeNull();
    expect(d.log.map((t) => t.id)).toEqual([secondId, firstId]);
    expect(d.events.map((e) => [e.kind, e.city])).toEqual([['stopped', 'denver'], ['done', 'houston']]);
    expect(d.release_version).toBeNull();

    const text = JSON.stringify(d);
    for (const secret of [PROXY_LOGIN, PROXY_PASS, FB_PASSWORD, 'secret-xs', 'url_enc', 'password_enc', 'v1.']) {
      expect(text).not.toContain(secret);
    }
  });

  it('finds a parked worker its account\'s slot by account number', async () => {
    const { no } = await seed();
    await claim('lab-1');
    expect((await api('POST', `/api/fleet/slots/${no}/park`, { token: manager })).status).toBe(200);
    const d = (await detail('lab-1')).body;
    expect(d.holds_slot).toBe(false);
    expect(d.slot).toMatchObject({ account_no: no, parked: true, worker_id: null });
    expect(d.account?.no).toBe(no);
  });

  it('is 404 for a worker the fleet does not know, and manager-only', async () => {
    expect((await detail('homelab-5')).status).toBe(404);
    expect((await detail('bad id!')).status).toBe(404);
    const purchaser = (await loginAs(MARCUS)).token;
    await seed();
    await claim('lab-1');
    expect((await detail('lab-1', purchaser)).status).toBe(403);
  });
});
