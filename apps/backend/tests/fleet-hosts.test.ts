import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createAdaptorServer } from '@hono/node-server';
import type { ClaimAnswer, DesiredAnswer, FleetHost, FleetRelease, FleetSlot, FleetWorker } from '@recycle-erp/shared';
import app from '../src/index';
import { attachVncBridge } from '../src/vncBridge';
import { FLEET_VNC_STALE_EPOCH, fleetVncState, startFleetRelayLease } from '../src/fleet/vnc';
import { gateOk } from '../src/fleet/hosts';
import { sha256hex } from '../src/fleet/sql';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { poolKey, seal } from '../src/lib/sealed';
import type { Env } from '../src/types';

// Hosts, releases, slots, workers and the VNC relay. Made-up material only.

const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const IMAGE_OLD = 'ghcr.io/example/aimm:0.13.9';
const IMAGE_NEW = 'ghcr.io/example/aimm:0.14.0';
const ENV: Partial<Env> = { FLEET_IMAGE_WORKER: IMAGE_OLD };

type HostView = FleetHost & { desired: { count: number; image: string; version: string; roll: { replace: string } | null } | null; token?: string };
type SlotView = FleetSlot & { uid: string | null; pool_status: string; minutes_today: number; budget_minutes: number; worker: (FleetWorker & { task: { id: number } | null }) | null };

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function seedHost(id = 'lab', token = HOST_TOKEN, capacity = 2, authoritative = true): Promise<void> {
  await getTestDb()`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative)
                    VALUES (${id}, ${sha256hex(token)}, ${capacity}, ${authoritative})`;
}

async function seedCatalog(): Promise<void> {
  const db = getTestDb();
  await db`INSERT INTO fleet_items (name, phrases) VALUES ('server_ram', '["server ram"]')`;
  await db`INSERT INTO fleet_cities (slug, name, enabled) VALUES ('houston', 'Houston', TRUE)`;
}

async function seedSlot(n: number, over: { worker?: string; host?: string; epoch?: number; quarantined?: boolean } = {}): Promise<number> {
  const db = getTestDb();
  const k = poolKey(testEnv)!;
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, cookie_enc)
    VALUES (${`6155000000000${n}`}, 'fixtures', 'fleet', ${over.worker ?? null}, ${seal(`pw-${n}`, k)}, ${seal(`c_user=6155000000000${n}; xs=x`, k)})
    RETURNING no`;
  await db`
    INSERT INTO fleet_slots (account_no, worker_id, host_id, last_host_id, epoch, lease_expires_at, proxy_url, quarantined_until)
    VALUES (${a.no}, ${over.worker ?? null}, ${over.host ?? null}, ${over.host ?? null}, ${over.epoch ?? 0},
            ${over.worker ? db`NOW() + interval '20 minutes'` : null}, ${seal('http://u:p@exit.example:1', k)},
            ${over.quarantined ? db`NOW() + interval '1 day'` : null})`;
  if (over.worker) {
    await db`INSERT INTO fleet_workers (worker_id, host_id, account_no, epoch, state, version, last_heartbeat_at, vnc_port)
             VALUES (${over.worker}, ${over.host ?? null}, ${a.no}, ${over.epoch ?? 0}, 'HEALTHY', '0.13.9', NOW(), 5901)`;
  }
  return a.no;
}

async function report(containers: Array<{ worker_id: string; image: string; state?: string; hold?: string; exit_code?: number | null; image_id?: string }>, token = HOST_TOKEN, host = 'lab') {
  return api('POST', `/api/fleet/hosts/${host}/report`, {
    headers: { ...bearer(token), 'X-Requested-By': 'an-agent' },
    body: { version: '1.340.0', containers: containers.map((c) => ({ state: 'running', ...c, started_at: '2026-10-24T10:00:00Z' })) },
  });
}

const desired = (token = HOST_TOKEN, host = 'lab', env: Partial<Env> = ENV) =>
  api<DesiredAnswer>('GET', `/api/fleet/hosts/${host}/desired`, { headers: bearer(token), env });

const release = async () => (await getTestDb()<{ value: FleetRelease }[]>`SELECT value FROM fleet_settings WHERE key = 'release'`)[0]?.value;

describe('hosts: manager routes', () => {
  beforeEach(async () => { await resetDb(); });

  it('registers a host, shows the token once, lists, updates and removes it', async () => {
    const { token } = await loginAs(ALEX);
    const made = await api<{ host: HostView }>('POST', '/api/fleet/hosts', { token, body: { host_id: 'worker-60-14' }, env: ENV });
    expect(made.status).toBe(200);
    expect(made.body.host.token).toMatch(/^[0-9a-f]{64}$/);
    expect(made.body.host).toMatchObject({ host_id: 'worker-60-14', capacity: 0, authoritative: false, report: null, desired: { count: 0, image: IMAGE_OLD, version: '0.13.9', roll: null } });
    expect((await api('POST', '/api/fleet/hosts', { token, body: { host_id: 'worker-60-14' } })).status).toBe(409);
    expect((await api('POST', '/api/fleet/hosts', { token, body: { host_id: 'Bad Host' } })).status).toBe(422);

    // The token works for the host, and is nowhere in the list.
    const hostToken = made.body.host.token!;
    expect((await desired(hostToken, 'worker-60-14')).status).toBe(200);
    const list = await api<{ hosts: HostView[]; release: FleetRelease | null }>('GET', '/api/fleet/hosts', { token, env: ENV });
    expect(list.body.hosts).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(hostToken);
    expect(JSON.stringify(list.body)).not.toContain('token_hash');
    expect(list.body.release).toBeNull();

    const put = await api<{ host: HostView }>('PUT', '/api/fleet/hosts/worker-60-14', { token, body: { capacity: 4, authoritative: true }, env: ENV });
    expect(put.body.host).toMatchObject({ capacity: 4, authoritative: true, desired: { count: 4 } });
    expect((await api('PUT', '/api/fleet/hosts/worker-60-14', { token, body: { capacity: -1 } })).status).toBe(422);
    expect((await api('PUT', '/api/fleet/hosts/nobody', { token, body: { capacity: 1 } })).status).toBe(404);
    expect((await api('DELETE', '/api/fleet/hosts/worker-60-14', { token })).status).toBe(200);
    expect((await desired(hostToken, 'worker-60-14')).status).toBe(401);
  });

  it('is manager scope, CSRF-guarded', async () => {
    expect((await api('GET', '/api/fleet/hosts')).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await api('GET', '/api/fleet/hosts', { token })).status).toBe(403);
    const alex = await loginAs(ALEX);
    expect((await api('POST', '/api/fleet/hosts', { token: alex.token, body: { host_id: 'x' }, headers: { 'X-Requested-By': 'nope' } })).status).toBe(403);
  });
});

describe('hosts: agent routes', () => {
  beforeEach(async () => { await resetDb(); await seedHost(); });

  it('desired honours authoritative=false, assigns VNC ports from 5901 and takes the image from the environment', async () => {
    await getTestDb()`UPDATE fleet_hosts SET authoritative = FALSE, capacity = 3 WHERE host_id = 'lab'`;
    const off = await desired();
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ authoritative: false, count: 0, image: IMAGE_OLD, version: '0.13.9', vnc_ports: {}, roll: null, leases: {} });
    await getTestDb()`UPDATE fleet_hosts SET authoritative = TRUE WHERE host_id = 'lab'`;
    const on = await desired();
    expect(on.body).toEqual({ authoritative: true, count: 3, image: IMAGE_OLD, version: '0.13.9', vnc_ports: { 'lab-1': 5901, 'lab-2': 5902, 'lab-3': 5903 }, roll: null, leases: {} });
    // Another host's id, or no token, is refused.
    expect((await desired(HOST_TOKEN, 'other')).status).toBe(401);
    expect((await api('GET', '/api/fleet/hosts/lab/desired')).status).toBe(401);
  });

  it('report is stored with last_seen_at and version, without a CSRF header, and shows in the manager list', async () => {
    const r = await report([{ worker_id: 'lab-1', image: IMAGE_OLD }]);
    expect(r.status).toBe(200);
    const { token } = await loginAs(ALEX);
    const list = await api<{ hosts: HostView[] }>('GET', '/api/fleet/hosts', { token, env: ENV });
    const lab = list.body.hosts[0];
    expect(lab.version).toBe('1.340.0');
    expect(lab.last_seen_at).not.toBeNull();
    expect(lab.report).toEqual({ version: '1.340.0', containers: [{ worker_id: 'lab-1', image: IMAGE_OLD, state: 'running', started_at: '2026-10-24T10:00:00Z' }] });
    expect((await api('POST', '/api/fleet/hosts/lab/report', { headers: bearer(HOST_TOKEN), body: { version: 1 } })).status).toBe(422);
  });
});

describe('releases', () => {
  beforeEach(async () => {
    await resetDb();
    await seedHost();
    await seedCatalog();
    await seedSlot(1, { worker: 'lab-1', host: 'lab', epoch: 1 });
    await seedSlot(2, { worker: 'lab-2', host: 'lab', epoch: 1 });
    await report([{ worker_id: 'lab-1', image: IMAGE_OLD }, { worker_id: 'lab-2', image: IMAGE_OLD }]);
  });

  const heartbeatOnNew = (worker: string, state = 'HEALTHY') => getTestDb()`
    UPDATE fleet_workers SET version = '0.14.0', state = ${state}, epoch = epoch + 1, last_heartbeat_at = NOW() + interval '1 second' WHERE worker_id = ${worker}`;

  it('replaces one idle worker at a time and gates on the replacement’s first healthy heartbeat', async () => {
    const { token } = await loginAs(ALEX);
    const started = await api<{ ok: true; release: FleetRelease }>('POST', '/api/fleet/releases', { token, body: { image: IMAGE_NEW, version: '0.14.0' } });
    expect(started.status).toBe(200);
    expect(started.body.release).toMatchObject({ state: 'rolling', image: IMAGE_NEW, current: null });

    // lab-1 holds a task: lab-2 goes first.
    await getTestDb()`INSERT INTO fleet_tasks (city, item, due_at, state, worker_id, account_no, epoch, leased_at, lease_expires_at)
                      VALUES ('houston', 'server_ram', NOW(), 'leased', 'lab-1', 1, 1, NOW(), NOW() + interval '30 minutes')`;
    const first = await desired();
    expect(first.body).toMatchObject({ image: IMAGE_NEW, version: '0.14.0', roll: { replace: 'lab-2' } });
    // The same command repeats until the replacement reports back.
    expect((await desired()).body.roll).toEqual({ replace: 'lab-2' });
    expect((await release()).current).toMatchObject({ worker_id: 'lab-2', host_id: 'lab', pre_state: 'HEALTHY' });

    // lab-2 comes back on the new version but DEGRADED: not good enough after HEALTHY.
    await heartbeatOnNew('lab-2', 'DEGRADED');
    expect((await desired()).body.roll).toEqual({ replace: 'lab-2' });
    await heartbeatOnNew('lab-2', 'HEALTHY');
    await report([{ worker_id: 'lab-1', image: IMAGE_OLD }, { worker_id: 'lab-2', image: IMAGE_NEW }]);
    // lab-1 is still busy: upgraded moves on, but nobody is replaced yet.
    expect((await desired()).body.roll).toBeNull();
    expect((await release()).upgraded).toEqual(['lab-2']);
    await getTestDb()`UPDATE fleet_tasks SET state = 'done', done_at = NOW()`;
    expect((await desired()).body.roll).toEqual({ replace: 'lab-1' });
    await heartbeatOnNew('lab-1');
    await report([{ worker_id: 'lab-1', image: IMAGE_NEW }, { worker_id: 'lab-2', image: IMAGE_NEW }]);
    expect((await desired()).body.roll).toBeNull();
    const done = await release();
    expect(done).toMatchObject({ state: 'done', upgraded: ['lab-2', 'lab-1'], skipped: [], current: null });
    expect(done.finished_at).not.toBeNull();
    // The manager's view says so too.
    const list = await api<{ hosts: HostView[]; release: FleetRelease }>('GET', '/api/fleet/hosts', { token });
    expect(list.body.release.state).toBe('done');
    expect(list.body.hosts[0].desired).toEqual({ count: 2, image: IMAGE_NEW, version: '0.14.0', roll: null });
  });

  it('skips workers on observe-only hosts, stops a release whose worker does not come back, and supersedes an active one', async () => {
    const otherToken = 'host-' + randomBytes(8).toString('hex');
    await seedHost('obs', otherToken, 1, false);
    await report([{ worker_id: 'obs-1', image: IMAGE_OLD }], otherToken, 'obs');
    const { token } = await loginAs(ALEX);
    await api('POST', '/api/fleet/releases', { token, body: { image: IMAGE_NEW, version: '0.14.0' } });
    expect((await desired(otherToken, 'obs')).body.roll).toBeNull();
    expect((await release()).skipped).toEqual(['obs-1']);
    expect((await desired()).body.roll).toEqual({ replace: 'lab-1' });

    // Twenty-one minutes later lab-1 still reports the old version.
    await getTestDb()`UPDATE fleet_settings SET value = jsonb_set(value, '{current,stopped_at}', to_jsonb((NOW() - interval '21 minutes')::text)) WHERE key = 'release'`;
    expect((await desired()).body.roll).toBeNull();
    const failed = await release();
    expect(failed.state).toBe('failed');
    expect(failed.failure).toMatch(/lab-1 did not come back on 0.14.0/);
    // A failed release no longer names the image; the environment does.
    expect((await desired()).body.image).toBe(IMAGE_OLD);

    const again = await api<{ ok: true; release: FleetRelease }>('POST', '/api/fleet/releases', { token, body: { image: IMAGE_NEW, version: '0.14.0' } });
    expect(again.body.release.state).toBe('rolling');
    expect((await api('POST', '/api/fleet/releases', { token, body: { image: 'not an image!', version: '1' } })).status).toBe(422);
  });

  it('leaves out a stopped container and a parked worker, with the reason, instead of naming them', async () => {
    await seedSlot(3, { worker: 'lab-3', host: 'lab', epoch: 1 });
    await seedSlot(4, { worker: 'lab-4', host: 'lab', epoch: 1 });
    await getTestDb()`UPDATE fleet_workers SET state = 'CHECKPOINT' WHERE worker_id = 'lab-2'`;
    const before = [
      { worker_id: 'lab-1', image: IMAGE_OLD, state: 'crash_limit', hold: 'crash_limit', exit_code: 1 },
      { worker_id: 'lab-2', image: IMAGE_OLD },
      { worker_id: 'lab-3', image: IMAGE_OLD, image_id: 'sha256:' + 'a'.repeat(64) },
      { worker_id: 'lab-4', image: IMAGE_OLD, state: 'exited', exit_code: 75 },
    ];
    await report(before);
    // The agent's extra fields are kept with the report.
    const [stored] = await getTestDb()<{ report: { containers: Array<Record<string, unknown>> } }[]>`SELECT report FROM fleet_hosts WHERE host_id = 'lab'`;
    expect(stored.report.containers[0]).toMatchObject({ hold: 'crash_limit', exit_code: 1 });
    expect(stored.report.containers[2]).toMatchObject({ image_id: 'sha256:' + 'a'.repeat(64) });
    const { token } = await loginAs(ALEX);
    await api('POST', '/api/fleet/releases', { token, body: { image: IMAGE_NEW, version: '0.14.0' } });
    expect((await desired()).body.roll).toEqual({ replace: 'lab-3' });
    const r = await release();
    expect(r.skipped.sort()).toEqual(['lab-1', 'lab-2', 'lab-4']);
    expect(r.skip_reasons).toEqual({ 'lab-1': 'held: crash_limit', 'lab-2': 'worker CHECKPOINT', 'lab-4': 'container exited' });
    await heartbeatOnNew('lab-3');
    await report(before.map((c) => (c.worker_id === 'lab-3' ? { ...c, image: IMAGE_NEW } : c)));
    expect((await desired()).body.roll).toBeNull();
    expect(await release()).toMatchObject({ state: 'done', upgraded: ['lab-3'] });
  });

  it('a report keeps only the host\'s own workers, so another host\'s worker is never rolled or drained', async () => {
    const otherToken = 'host-' + randomBytes(8).toString('hex');
    await seedHost('lab2', otherToken, 1, true);
    const r = await report([{ worker_id: 'lab-1', image: IMAGE_OLD }, { worker_id: 'lab2-1', image: IMAGE_OLD }, { worker_id: 'lab2-x', image: IMAGE_OLD }], otherToken, 'lab2');
    expect(r.status).toBe(200);
    const [row] = await getTestDb()<{ report: { containers: Array<{ worker_id: string }> } }[]>`SELECT report FROM fleet_hosts WHERE host_id = 'lab2'`;
    expect(row.report.containers.map((c) => c.worker_id)).toEqual(['lab2-1']);
    const { token } = await loginAs(ALEX);
    await api('POST', '/api/fleet/releases', { token, body: { image: IMAGE_NEW, version: '0.14.0' } });
    expect((await desired(otherToken, 'lab2')).body.roll).toEqual({ replace: 'lab2-1' });
    expect((await release()).current).toMatchObject({ worker_id: 'lab2-1', host_id: 'lab2' });
  });

  it('one agent instance holds a host: a second is refused 403 until the first has been silent two minutes', async () => {
    const as = (instance: string) => ({ ...bearer(HOST_TOKEN), 'X-Fleet-Agent-Instance': instance, 'X-Fleet-Docker-Daemon': 'daemon-a' });
    expect((await api('GET', '/api/fleet/hosts/lab/desired', { headers: as('first'), env: ENV })).status).toBe(200);
    const second = await api<{ error: string }>('GET', '/api/fleet/hosts/lab/desired', { headers: as('second'), env: ENV });
    expect(second.status).toBe(403);
    expect(second.body.error).toBe('agent_conflict');
    const body = { version: '1.352.0', containers: [], agent: { instance_id: 'second', daemon_id: 'daemon-a' } };
    expect((await api('POST', '/api/fleet/hosts/lab/report', { headers: as('second'), body })).status).toBe(403);
    // An agent from before instance ids is let through as before.
    expect((await desired()).status).toBe(200);
    await getTestDb()`UPDATE fleet_hosts SET agent_seen_at = NOW() - interval '3 minutes' WHERE host_id = 'lab'`;
    expect((await api('POST', '/api/fleet/hosts/lab/report', { headers: as('second'), body })).status).toBe(200);
    const [h] = await getTestDb()<{ agent_instance: string; report: { agent: unknown } }[]>`SELECT agent_instance, report FROM fleet_hosts WHERE host_id = 'lab'`;
    expect(h.agent_instance).toBe('second');
    expect(h.report.agent).toEqual({ instance_id: 'second', daemon_id: 'daemon-a' });
    expect((await api('GET', '/api/fleet/hosts/lab/desired', { headers: as('first'), env: ENV })).status).toBe(403);
  });

  it('removing a host frees the accounts it had reserved for a replacement, and drops its pending replacement', async () => {
    const db = getTestDb();
    const { token } = await loginAs(ALEX);
    await api('POST', '/api/fleet/releases', { token, body: { image: IMAGE_NEW, version: '0.14.0' } });
    expect((await desired()).body.roll).toEqual({ replace: 'lab-1' });
    // lab-1 stopped for its replacement: the account is reserved under a handoff.
    await db`UPDATE fleet_slots SET epoch = 2, handoff_epoch = 1, reserved_until = NOW() + interval '20 minutes',
             lease_expires_at = NOW() + interval '20 minutes' WHERE worker_id = 'lab-1'`;
    expect((await api('DELETE', '/api/fleet/hosts/lab', { token })).status).toBe(200);
    const slots = await db<{ worker_id: string | null; lease_expires_at: Date | null; reserved_until: Date | null; handoff_epoch: number | null; epoch: number }[]>`
      SELECT worker_id, lease_expires_at, reserved_until, handoff_epoch, epoch FROM fleet_slots ORDER BY account_no`;
    expect(slots[0]).toEqual({ worker_id: null, lease_expires_at: null, reserved_until: null, handoff_epoch: null, epoch: 3 });
    // lab-2 was running, not reserved: its lease is its own to run out.
    expect(slots[1].worker_id).toBe('lab-2');
    const r = await release();
    expect(r.current).toBeNull();
    expect(r.skip_reasons).toMatchObject({ 'lab-1': 'host removed' });
  });

  it('gate_ok as the coordinator had it', () => {
    expect(gateOk('HEALTHY', 'HEALTHY')).toBe(true);
    expect(gateOk('HEALTHY', 'DEGRADED')).toBe(false);
    expect(gateOk('SESSION_EXPIRED', 'SESSION_EXPIRED')).toBe(true);
    expect(gateOk('SESSION_EXPIRED', 'DEAD')).toBe(false);
    expect(gateOk('DOWN', null)).toBe(true);
    expect(gateOk(null, 'DEAD')).toBe(true);
  });
});

describe('slots and workers', () => {
  beforeEach(async () => { await resetDb(); await seedHost(); await seedCatalog(); });

  it('lists slots with the pool status, today’s minutes and the worker’s task; parks and unparks; lifts a quarantine', async () => {
    const running = await seedSlot(1, { worker: 'lab-1', host: 'lab', epoch: 3 });
    const idle = await seedSlot(2, { quarantined: true });
    const db = getTestDb();
    const [t] = await db<{ id: number }[]>`
      INSERT INTO fleet_tasks (city, item, due_at, state, worker_id, account_no, epoch, leased_at, lease_expires_at)
      VALUES ('houston', 'server_ram', NOW(), 'leased', 'lab-1', ${running}, 3, NOW() - interval '10 minutes', NOW() + interval '20 minutes')
      RETURNING id::int AS id`;
    // An hour from this UTC day's midnight: "two hours ago" is yesterday when
    // the suite runs in the small hours, and today's minutes would miss it.
    await db`WITH d AS (SELECT date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS midnight)
             INSERT INTO fleet_tasks (city, item, due_at, state, worker_id, account_no, epoch, leased_at, lease_expires_at, done_at)
             SELECT 'houston', 'server_ram', NOW(), 'done', 'lab-1', ${running}, 3, midnight, midnight + interval '30 minutes', midnight + interval '60 minutes' FROM d`;
    const { token } = await loginAs(ALEX);
    const list = await api<{ slots: SlotView[] }>('GET', '/api/fleet/slots', { token });
    expect(list.status).toBe(200);
    expect(list.body.slots).toHaveLength(2);
    const [a, b] = list.body.slots;
    expect(a).toMatchObject({ account_no: running, uid: '61550000000001', pool_status: 'fleet', worker_id: 'lab-1', epoch: 3, has_proxy: true, parked: false, budget_minutes: 360 });
    expect(a.minutes_today).toBe(70);
    expect(a.worker).toMatchObject({ worker_id: 'lab-1', state: 'HEALTHY', task: { id: t.id, city: 'houston', city_name: 'Houston', state: 'leased' } });
    expect(JSON.stringify(list.body)).not.toContain('exit.example');
    expect(b).toMatchObject({ account_no: idle, worker: null, parked: false });
    expect(b.quarantined_until).not.toBeNull();

    const workers = await api<{ workers: Array<FleetWorker & { task: { id: number } | null }> }>('GET', '/api/fleet/workers', { token });
    expect(workers.body.workers).toHaveLength(1);
    expect(workers.body.workers[0]).toMatchObject({ worker_id: 'lab-1', account_no: running, task: { id: t.id } });

    const lifted = await api<{ slot: SlotView }>('POST', `/api/fleet/slots/${idle}/release-quarantine`, { token, body: {} });
    expect(lifted.body.slot.quarantined_until).toBeNull();

    const parked = await api<{ slot: SlotView }>('POST', `/api/fleet/slots/${running}/park`, { token, body: {} });
    expect(parked.status).toBe(200);
    expect(parked.body.slot).toMatchObject({ parked: true, worker_id: null, host_id: null, epoch: 4, lease_expires_at: null, worker: null });
    const released = await db<{ state: string; worker_id: string | null }[]>`SELECT state, worker_id FROM fleet_tasks WHERE id = ${t.id}`;
    expect(released[0]).toEqual({ state: 'ready', worker_id: null });
    expect((await db<{ kind: string }[]>`SELECT kind FROM fleet_task_events WHERE task_id = ${t.id}`).map((e) => e.kind)).toEqual(['released']);
    // Nothing claims a parked slot; unparking frees it.
    const claimOpts = { headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id: 'lab-9', version: '0.14.0', vnc_port: null } };
    await api('POST', `/api/fleet/slots/${idle}/park`, { token, body: {} });
    expect((await api('POST', '/api/fleet/worker/claim', claimOpts)).status).toBe(409);
    const unparked = await api<{ slot: SlotView }>('POST', `/api/fleet/slots/${running}/unpark`, { token, body: {} });
    expect(unparked.body.slot).toMatchObject({ parked: false, lease_expires_at: null });
    const got = await api<ClaimAnswer>('POST', '/api/fleet/worker/claim', claimOpts);
    expect(got.status).toBe(200);
    expect(got.body.account.no).toBe(running);
    expect(got.body.epoch).toBe(5);
    expect((await api('POST', '/api/fleet/slots/999/park', { token, body: {} })).status).toBe(404);
  });

  it('is manager scope', async () => {
    expect((await api('GET', '/api/fleet/slots')).status).toBe(401);
    expect((await api('GET', '/api/fleet/workers')).status).toBe(401);
    const { token } = await loginAs(MARCUS);
    expect((await api('GET', '/api/fleet/slots', { token })).status).toBe(403);
  });
});

describe('the fleet VNC relay', () => {
  let erp: Server;
  let port: number;
  let env: Env;

  let lease: { stop(): void; ready: Promise<boolean> };

  beforeAll(async () => {
    env = Object.assign(Object.create(testEnv), {});
    erp = createAdaptorServer({ fetch: (req) => app.fetch(req, env) }) as Server;
    attachVncBridge(erp, app, env, { revalidateMs: 150 });
    port = await new Promise<number>((resolve) => erp.listen(0, '127.0.0.1', () => resolve((erp.address() as AddressInfo).port)));
  });

  afterAll(async () => {
    lease?.stop();
    erp.closeAllConnections();
    await new Promise((r) => erp.close(r));
  });

  // resetDb drops the database under every pooled connection, the relay
  // lock's included, so each test takes the lock afresh.
  beforeEach(async () => {
    lease?.stop();
    await resetDb(); await seedHost(); await seedCatalog(); await seedSlot(1);
    lease = startFleetRelayLease(getTestDb(), { retryMs: 100 });
    expect(await lease.ready).toBe(true);
  });

  type Outcome = { messages: string[]; close?: { code: number; reason: string }; status?: number; open?: boolean };

  function open(path: string, headers: Record<string, string>): { ws: WebSocket; outcome: Promise<Outcome>; out: Outcome } {
    const out: Outcome = { messages: [] };
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const outcome = new Promise<Outcome>((resolve) => {
      ws.on('open', () => { out.open = true; });
      ws.on('message', (d) => out.messages.push(String(d)));
      ws.on('unexpected-response', (_req, res) => { out.status = res.statusCode; resolve(out); });
      ws.on('close', (code, reason) => { out.close = { code, reason: String(reason) }; resolve(out); });
      ws.on('error', () => { /* surfaced through close / unexpected-response */ });
    });
    return { ws, outcome, out };
  }

  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  async function workerToken(): Promise<string> {
    const r = await api<ClaimAnswer>('POST', '/api/fleet/worker/claim', {
      headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id: 'lab-1', version: '0.14.0', vnc_port: 5901 },
    });
    expect(r.status).toBe(200);
    return r.body.worker_token;
  }

  it('parks a worker’s socket by its token and pairs a manager’s viewer with it, bytes both ways, ending together', async () => {
    const wt = await workerToken();
    const worker = open('/api/fleet/worker/vnc', { Authorization: `Bearer ${wt}` });
    await settle();
    expect(worker.out.open).toBe(true);
    expect(fleetVncState().parked).toEqual(['lab-1']);

    const { token } = await loginAs(ALEX);
    const viewer = open('/api/fleet/vnc/lab-1/ws', { Cookie: `at=${token}`, Origin: 'http://localhost:5173' });
    await settle();
    expect(viewer.out.open).toBe(true);
    expect(fleetVncState()).toEqual({ parked: [], bridges: 1 });
    // The worker hears about the viewer before it may speak.
    expect(worker.out.messages).toEqual(['viewer']);
    worker.ws.send(Buffer.from('RFB 003.008\n'));
    viewer.ws.send(Buffer.from('RFB 003.008\n'));
    await settle();
    expect(viewer.out.messages).toEqual(['RFB 003.008\n']);
    expect(worker.out.messages).toEqual(['viewer', 'RFB 003.008\n']);
    viewer.ws.close(1000, 'done watching');
    const w = await worker.outcome;
    expect(w.close?.code).toBe(1000);
    expect(fleetVncState()).toEqual({ parked: [], bridges: 0 });
  });

  it('closes a parked worker socket within a minute of its slot moving on, with a code the worker exits on', async () => {
    const wt = await workerToken();
    const worker = open('/api/fleet/worker/vnc', { Authorization: `Bearer ${wt}` });
    await settle();
    expect(fleetVncState().parked).toEqual(['lab-1']);
    await getTestDb()`UPDATE fleet_slots SET epoch = epoch + 1`;
    const w = await worker.outcome;
    expect(w.close?.code).toBe(FLEET_VNC_STALE_EPOCH);
    // The server's own close event lands after the client has seen the frame.
    for (let i = 0; i < 20 && fleetVncState().parked.length; i++) await settle(50);
    expect(fleetVncState().parked).toEqual([]);
  });

  it('only the instance holding the relay lock serves it; the rest refuse both ends', async () => {
    // Another instance's connection cannot take the lock while this one holds it.
    const other = await getTestDb().reserve();
    try {
      const [r] = await other<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended('fleet-vnc-relay', 0)) AS ok`;
      if (r.ok) await other`SELECT pg_advisory_unlock(hashtextextended('fleet-vnc-relay', 0))`;
      expect(r.ok).toBe(false);
    } finally { other.release(); }
    lease.stop();
    const wt = await workerToken();
    const { token } = await loginAs(ALEX);
    expect((await open('/api/fleet/worker/vnc', { Authorization: `Bearer ${wt}` }).outcome).status).toBe(503);
    expect((await open('/api/fleet/vnc/lab-1/ws', { Cookie: `at=${token}`, Origin: 'http://localhost:5173' }).outcome).status).toBe(503);
    lease = startFleetRelayLease(getTestDb(), { retryMs: 100 });
    expect(await lease.ready).toBe(true);
    const back = open('/api/fleet/worker/vnc', { Authorization: `Bearer ${wt}` });
    await settle();
    expect(back.out.open).toBe(true);
    back.ws.close();
    await back.outcome;
  });

  it('tells a viewer when the worker has no relay connected, and refuses the wrong callers', async () => {
    const { token } = await loginAs(ALEX);
    const none = await open('/api/fleet/vnc/lab-1/ws', { Cookie: `at=${token}`, Origin: 'http://localhost:5173' }).outcome;
    expect(none.close).toEqual({ code: 1011, reason: 'lab-1 has no VNC relay connected' });
    expect((await open('/api/fleet/vnc/lab-1/ws', { Origin: 'http://localhost:5173' }).outcome).status).toBe(401);
    const marcus = await loginAs(MARCUS);
    expect((await open('/api/fleet/vnc/lab-1/ws', { Cookie: `at=${marcus.token}`, Origin: 'http://localhost:5173' }).outcome).status).toBe(403);
    expect((await open('/api/fleet/vnc/lab-1/ws', { Cookie: `at=${token}`, Origin: 'https://evil.example' }).outcome).status).toBe(403);
    // A worker needs its own token; a manager cookie or a host token will not park a socket.
    expect((await open('/api/fleet/worker/vnc', { Cookie: `at=${token}` }).outcome).status).toBe(401);
    expect((await open('/api/fleet/worker/vnc', { Authorization: `Bearer ${HOST_TOKEN}` }).outcome).status).toBe(401);
    // A stale worker token is a 409, so the old container stops dialling.
    const wt = await workerToken();
    await getTestDb()`UPDATE fleet_slots SET epoch = epoch + 1`;
    expect((await open('/api/fleet/worker/vnc', { Authorization: `Bearer ${wt}` }).outcome).status).toBe(409);
    // The coordinator's own path and any other upgrade still behave as before.
    expect((await open('/api/orders', { Cookie: `at=${token}` }).outcome).status).toBe(404);
  });
});

describe('confirmed-stop handoff with the real agent planner', () => {
  beforeEach(async () => { await resetDb(); await seedHost('lab', HOST_TOKEN, 1); await seedCatalog(); });

  it('survives a stagger and a lost stop reply with a full pool, then gates on the new epoch', async () => {
    const { Agent } = await import('../../fleet-agent/src/agent');
    const { FakeDocker, running } = await import('../../fleet-agent/tests/helpers/fake-docker');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { saveMemory } = await import('../../fleet-agent/src/state');
    const no = await seedSlot(1, { worker: 'lab-1', host: 'lab', epoch: 1 });
    const dir = mkdtempSync(join(tmpdir(), 'fleet-handoff-'));
    let clock = Date.now();
    saveMemory(dir, { last_start_at: clock - 60_000, restarts: {}, pending: {} });
    const docker = new FakeDocker([running('lab-1', IMAGE_OLD)], [IMAGE_OLD, IMAGE_NEW]);
    await report([{ worker_id: 'lab-1', image: IMAGE_OLD }]);
    const { token } = await loginAs(ALEX);
    await api('POST', '/api/fleet/releases', { token, body: { image: IMAGE_NEW, version: '0.14.0' } });
    let lost = true;
    const client = {
      desired: async () => (await desired()).body,
      report: async (body: unknown) => (await api('POST', '/api/fleet/hosts/lab/report', { headers: bearer(HOST_TOKEN), body })).status === 200,
      stopped: async (worker_id: string, identity: { account_no: number; epoch: number; restart: boolean }) => {
        const r = await api('POST', '/api/fleet/hosts/lab/stopped', { headers: bearer(HOST_TOKEN), body: { worker_id, ...identity } });
        expect(r.status).toBe(200);
        if (lost) { lost = false; return false; }
        return true;
      },
      ticket: async (worker_id: string, handoff_epoch?: number) => {
        const r = await api<{ ticket: string }>('POST', '/api/fleet/hosts/lab/tickets', { headers: bearer(HOST_TOKEN), body: { worker_id, handoff_epoch } });
        expect(r.status).toBe(200);
        return r.body.ticket;
      },
    };
    let replacement: ClaimAnswer | null = null;
    const originalRun = docker.run.bind(docker);
    docker.run = async (spec, env) => {
      // The container claims with the ticket the agent minted for it, never the host token.
      expect(Object.values(env)).not.toContain(HOST_TOKEN);
      const r = await api<ClaimAnswer>('POST', '/api/fleet/worker/claim', { headers: bearer(spec.ticket), body: {
        host_id: 'lab', worker_id: spec.worker_id, version: '0.14.0', claim_id: 'replacement-boot', handoff_epoch: spec.handoff_epoch,
      } });
      expect(r.status).toBe(200); replacement = r.body;
      expect(r.body.account.no).toBe(no);
      return originalRun(spec, env);
    };
    const agent = () => new Agent({ hostId: 'lab', stateDir: dir, client, docker,
      workerEnv: { url: 'http://test', hostId: 'lab' }, version: 'test', now: () => clock });
    try {
      expect((await agent().tick()).actions).toEqual([]);
      expect((await desired()).body.roll).toEqual({ replace: 'lab-1' });
      clock += 180_000;
      expect((await agent().tick()).errors).toHaveLength(1);
      expect(docker.containers.size).toBe(0);
      // The old account is reserved, not available to another worker.
      expect((await api('POST', '/api/fleet/worker/claim', { headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id: 'lab-2', version: 'test' } })).status).toBe(409);
      expect((await agent().tick()).errors).toEqual([]);
      expect(docker.commands.filter(c => c[0] === 'run')).toHaveLength(1);
      expect(docker.commands.filter(c => c[0] === 'stop+rm')).toHaveLength(1);
      expect(replacement!.epoch).toBeGreaterThan(1);
      const [booting] = await getTestDb()`SELECT state, last_heartbeat_at FROM fleet_workers WHERE worker_id = 'lab-1'`;
      expect(booting).toEqual({ state: null, last_heartbeat_at: null });
      expect((await desired()).body.roll).toEqual({ replace: 'lab-1' });
      const newer = replacement as unknown as ClaimAnswer;
      await api('POST', '/api/fleet/worker/heartbeat', { headers: bearer(newer.worker_token), body: { state: 'HEALTHY', version: '0.14.0' } });
      expect((await desired()).body.roll).toBeNull();
      expect((await release()).state).toBe('done');
      // A new boot cannot reuse an already-consumed handoff.
      expect((await api('POST', '/api/fleet/worker/claim', { headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id: 'lab-1', version: 'test', claim_id: 'unexpected-boot', handoff_epoch: 1 } })).status).toBe(409);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('drains task allocation and rejects a stop confirmation from another host', async () => {
    await seedSlot(1, { worker: 'lab-1', host: 'lab', epoch: 1 });
    const { signWorkerToken, workerTokenKey } = await import('../src/fleet/auth');
    const worker = signWorkerToken({ worker_id: 'lab-1', account_no: 1, epoch: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, workerTokenKey(testEnv)!);
    await report([{ worker_id: 'lab-1', image: IMAGE_OLD }]);
    const { token } = await loginAs(ALEX);
    await api('POST', '/api/fleet/releases', { token, body: { image: IMAGE_NEW, version: '0.14.0' } });
    await desired();
    await getTestDb()`INSERT INTO fleet_tasks (city,item,due_at,state) VALUES ('houston','server_ram',NOW(),'ready')`;
    const next = await api('POST', '/api/fleet/worker/next-task', { headers: bearer(worker), body: { wait: 0 } });
    expect(next.body).toEqual({ task: null, reason: 'draining', retry_after: 30 });
    await seedHost('other', 'made-up-other-token');
    expect((await api('POST', '/api/fleet/hosts/other/stopped', { headers: bearer('made-up-other-token'), body: { worker_id: 'lab-1', account_no: 1, epoch: 1, restart: true } })).status).toBe(409);
  });
});

describe('handoff reservations', () => {
  beforeEach(async () => { await resetDb(); await seedHost(); await seedCatalog(); });

  const stopped = (body: Record<string, unknown>) =>
    api('POST', '/api/fleet/hosts/lab/stopped', { headers: bearer(HOST_TOKEN), body });
  const claimAs = (worker_id: string, more: Record<string, unknown> = {}) =>
    api<ClaimAnswer & { error?: string }>('POST', '/api/fleet/worker/claim', { headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id, version: 'test', ...more } });
  const slotOf = async (no: number) => {
    const { token } = await loginAs(ALEX);
    return (await api<{ slots: SlotView[] }>('GET', '/api/fleet/slots', { token })).body.slots.find((s) => s.account_no === no)!;
  };

  it('holds the account for the gate timeout, shows it as reserved rather than parked, then frees it by itself', async () => {
    const no = await seedSlot(1, { worker: 'lab-1', host: 'lab', epoch: 4 });
    expect((await stopped({ worker_id: 'lab-1', account_no: no, epoch: 4, restart: true })).status).toBe(200);
    const [row] = await getTestDb()<{ minutes: number; same: boolean }[]>`
      SELECT (EXTRACT(EPOCH FROM reserved_until - NOW()) / 60)::float8 AS minutes, reserved_until = lease_expires_at AS same FROM fleet_slots WHERE account_no = ${no}`;
    expect(row.minutes).toBeGreaterThan(19);
    expect(row.minutes).toBeLessThanOrEqual(20);
    expect(row.same).toBe(true);
    const view = await slotOf(no);
    expect(view.parked).toBe(false);
    expect(view.reserved_until).not.toBeNull();
    // Nobody else takes it, and lab-1 itself needs the handoff epoch.
    expect((await claimAs('lab-2')).status).toBe(409);
    expect((await claimAs('lab-1')).status).toBe(409);
    // The replacement never came: the reservation lapses and anyone may claim.
    await getTestDb()`UPDATE fleet_slots SET reserved_until = NOW() - interval '1 second', lease_expires_at = NOW() - interval '1 second' WHERE account_no = ${no}`;
    expect((await slotOf(no)).reserved_until).toBeNull();
    const taken = await claimAs('lab-2');
    expect(taken.status).toBe(200);
    expect(taken.body.account.no).toBe(no);
  });

  it('a replacement whose reservation lapsed still claims its own (now free) slot', async () => {
    const no = await seedSlot(1, { worker: 'lab-1', host: 'lab', epoch: 4 });
    await stopped({ worker_id: 'lab-1', account_no: no, epoch: 4, restart: true });
    await getTestDb()`UPDATE fleet_slots SET reserved_until = NOW() - interval '1 second', lease_expires_at = NOW() - interval '1 second' WHERE account_no = ${no}`;
    const r = await claimAs('lab-1', { handoff_epoch: 4, claim_id: 'late-boot' });
    expect(r.status).toBe(200);
    expect(r.body.account.no).toBe(no);
    const [slot] = await getTestDb()`SELECT reserved_until, handoff_epoch FROM fleet_slots WHERE account_no = ${no}`;
    expect(slot).toEqual({ reserved_until: null, handoff_epoch: null });
  });

  it('park clears a reservation; unpark clears the handoff too; a late restart:false retry frees nothing it should not', async () => {
    const no = await seedSlot(1, { worker: 'lab-1', host: 'lab', epoch: 4 });
    await stopped({ worker_id: 'lab-1', account_no: no, epoch: 4, restart: true });
    const { token } = await loginAs(ALEX);
    await api('POST', `/api/fleet/slots/${no}/park`, { token, body: {} });
    let [slot] = await getTestDb()`SELECT reserved_until, handoff_epoch, worker_id FROM fleet_slots WHERE account_no = ${no}`;
    expect(slot).toEqual({ reserved_until: null, handoff_epoch: null, worker_id: null });
    expect((await claimAs('lab-1', { handoff_epoch: 4 })).status).toBe(409);
    await getTestDb()`UPDATE fleet_slots SET handoff_epoch = 4 WHERE account_no = ${no}`;
    await api('POST', `/api/fleet/slots/${no}/unpark`, { token, body: {} });
    [slot] = await getTestDb()`SELECT reserved_until, handoff_epoch, lease_expires_at FROM fleet_slots WHERE account_no = ${no}`;
    expect(slot).toEqual({ reserved_until: null, handoff_epoch: null, lease_expires_at: null });

    // A handoff that was consumed: a delayed restart:false for it must not end the new lease.
    const other = await seedSlot(2, { worker: 'lab-2', host: 'lab', epoch: 7 });
    await stopped({ worker_id: 'lab-2', account_no: other, epoch: 7, restart: true });
    expect((await claimAs('lab-2', { handoff_epoch: 7, claim_id: 'b' })).status).toBe(200);
    expect((await stopped({ worker_id: 'lab-2', account_no: other, epoch: 7, restart: false })).status).toBe(200);
    const [live] = await getTestDb()<{ live: boolean }[]>`SELECT lease_expires_at > NOW() AS live FROM fleet_slots WHERE account_no = ${other}`;
    expect(live.live).toBe(true);
  });
});
