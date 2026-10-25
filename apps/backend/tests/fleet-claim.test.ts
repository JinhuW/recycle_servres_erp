import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { ClaimAnswer, FleetCookie, NextTaskAnswer } from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { signWorkerToken, workerTokenKey } from '../src/fleet/auth';
import { sha256hex } from '../src/fleet/sql';
import { cookiesFromText } from '../src/fleet/claim';
import { notifyReady } from '../src/fleet/scheduler';
import { ALEX, loginAs } from './helpers/auth';
import { poolKey, seal, unseal } from '../src/lib/sealed';

// The worker protocol end to end against the real schema. Every account, host,
// token, proxy and cookie here is made up; the sealing key is the one the test
// environment derives from its random JWT_SECRET.

const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const OTHER_HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const key = () => poolKey(testEnv)!;

type Headers = Record<string, string>;
const bearer = (token: string): Headers => ({ Authorization: `Bearer ${token}` });

async function seedBase(): Promise<void> {
  const db = getTestDb();
  await db`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative)
           VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 2, TRUE), ('other', ${sha256hex(OTHER_HOST_TOKEN)}, 1, TRUE)`;
  await db`INSERT INTO fleet_items (name, phrases, filters) VALUES
           ('server_ram', '["server ram"]', '{"date_listed": "last-24-hours"}'),
           ('enterprise_ssd', '["enterprise ssd"]', '{}')`;
  await db`INSERT INTO fleet_cities (slug, name, enabled) VALUES
           ('houston', 'Houston', TRUE), ('denver', 'Denver', TRUE), ('nyc', 'New York', TRUE), ('boise', 'Boise', FALSE)`;
}

type SlotOpts = {
  uid?: string; home?: string[]; lastHost?: string | null; proxy?: string | null; cookie?: string;
  quarantinedUntil?: string | null; status?: string;
};

/** A made-up pool account in the fleet with its slot; answers the account number. */
async function seedSlot(n: number, o: SlotOpts = {}): Promise<number> {
  const db = getTestDb();
  const k = key();
  const uid = o.uid ?? `6155000000000${n}`;
  const cookie = o.cookie ?? `c_user=${uid}; xs=xs-secret-${n}; datr=datr-${n}`;
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, totp_enc, cookie_enc, cookie_uid, token_enc)
    VALUES (${uid}, 'fixtures', ${o.status ?? 'fleet'}, ${`old-worker-${n}`},
            ${seal(`pw-${n}`, k)}, ${seal(`abcd efgh-${n}`, k)}, ${seal(cookie, k)}, ${uid}, ${seal(`EAA-token-${n}`, k)})
    RETURNING no`;
  const proxy = o.proxy === undefined ? `http://proxy-user:proxy-pass@exit-${n}.example:10000` : o.proxy;
  await db`
    INSERT INTO fleet_slots (account_no, last_host_id, proxy_url, home_cities, quarantined_until)
    VALUES (${a.no}, ${o.lastHost ?? null}, ${proxy ? seal(proxy, k) : null}, ${db.json(o.home ?? [])},
            ${o.quarantinedUntil ?? null})`;
  return a.no;
}

async function addTask(city: string, item = 'server_ram', over: Record<string, unknown> = {}): Promise<number> {
  const db = getTestDb();
  const kind = (over.kind as string) ?? 'search';
  const priority = (over.priority as number) ?? 0;
  const reason = (over.reason as string) ?? 'cadence';
  const due = (over.due_at as string) ?? 'NOW()';
  const accountNo = (over.account_no as number) ?? null;
  const [t] = await db<{ id: number }[]>`
    INSERT INTO fleet_tasks (city, item, kind, due_at, priority, state, reason, account_no)
    VALUES (${city}, ${item}, ${kind}, ${due === 'NOW()' ? db`NOW()` : due}, ${priority}, 'ready', ${reason}, ${accountNo})
    RETURNING id::int AS id`;
  return t.id;
}

async function claim(workerId: string, token = HOST_TOKEN, hostId = 'lab', extra: Headers = {}) {
  return api<ClaimAnswer & { error?: string }>('POST', '/api/fleet/worker/claim', {
    headers: { ...bearer(token), ...extra },
    body: { host_id: hostId, worker_id: workerId, version: '0.14.0', vnc_port: 5901 },
  });
}

async function claimed(workerId: string): Promise<ClaimAnswer> {
  const r = await claim(workerId);
  expect(r.status).toBe(200);
  return r.body;
}

const nextTask = (token: string, done: unknown = null, wait = 0) =>
  api<NextTaskAnswer & { error?: string }>('POST', '/api/fleet/worker/next-task', { headers: bearer(token), body: { done, wait } });

const heartbeat = (token: string, state: string, more: Record<string, unknown> = {}) =>
  api<{ ok: boolean; directives: string[]; error?: string }>('POST', '/api/fleet/worker/heartbeat', {
    headers: bearer(token), body: { state, version: '0.14.0', vnc_port: 5901, last_search_at: null, ...more },
  });

async function taskRow(id: number) {
  const [t] = await getTestDb()<Record<string, unknown>[]>`SELECT * FROM fleet_tasks WHERE id = ${id}`;
  return t;
}

async function events(id: number): Promise<string[]> {
  const rows = await getTestDb()<{ kind: string }[]>`SELECT kind FROM fleet_task_events WHERE task_id = ${id} ORDER BY id`;
  return rows.map((r) => r.kind);
}

describe('POST /api/fleet/worker/claim', () => {
  beforeEach(async () => { await resetDb(); await seedBase(); });

  it('hands the slot with its secrets unsealed, opens the stint and mints a token for epoch 1', async () => {
    const no = await seedSlot(1, { home: ['nyc'], lastHost: 'lab' });
    const r = await claim('lab-1');
    expect(r.status).toBe(200);
    const a = r.body;
    expect(a.epoch).toBe(1);
    expect(a.account).toMatchObject({ no, uid: '61550000000001', password: 'pw-1', totp_secret: 'ABCDEFGH1', token: 'EAA-token-1' });
    expect(a.account.cookies.map((c) => c.name)).toEqual(['c_user', 'xs', 'datr']);
    expect(a.account.cookies[1]).toMatchObject({ value: 'xs-secret-1', domain: '.facebook.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' });
    expect(a.proxy).toEqual({ url: 'http://proxy-user:proxy-pass@exit-1.example:10000' });
    expect(a.device).toMatchObject({ viewport: [1366, 768], locale: 'en-US' });
    expect(a.home_cities).toEqual(['nyc']);
    expect(a.items.map((i) => i.name)).toEqual(['enterprise_ssd', 'server_ram']);
    expect(a.settings).toMatchObject({ lease_minutes: 30, poll_hold_seconds: 50, coordinator_url: '' });
    expect(a.settings.search).toEqual({});

    const db = getTestDb();
    const [slot] = await db<Record<string, unknown>[]>`SELECT * FROM fleet_slots WHERE account_no = ${no}`;
    expect(slot).toMatchObject({ worker_id: 'lab-1', host_id: 'lab', last_host_id: 'lab', epoch: 1 });
    expect((slot.lease_expires_at as Date).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    const [pool] = await db<{ holder_name: string; status: string }[]>`SELECT holder_name, status FROM fb_pool_accounts WHERE no = ${no}`;
    expect(pool).toEqual({ holder_name: 'lab-1', status: 'fleet' });
    // The trigger closed the previous worker's stint and opened lab-1's, with the proxy exit (no login) stamped on it.
    const stints = await db<{ worker_id: string; ended_at: Date | null; outcome: string | null; proxy_url: string | null }[]>`
      SELECT worker_id, ended_at, outcome, proxy_url FROM fb_worker_accounts WHERE account_no = ${no} ORDER BY started_at`;
    expect(stints.map((s) => [s.worker_id, s.outcome, s.proxy_url])).toEqual([
      ['old-worker-1', 'fleet', null], ['lab-1', null, 'http://exit-1.example:10000'],
    ]);
    const [ev] = await db<{ kind: string; actor_name: string; detail: string }[]>`
      SELECT kind, actor_name, detail FROM fb_pool_events WHERE account_no = ${no}`;
    expect(ev).toEqual({ kind: 'assigned', actor_name: 'fleet host lab', detail: 'lab-1' });
    const [w] = await db<Record<string, unknown>[]>`SELECT * FROM fleet_workers WHERE worker_id = 'lab-1'`;
    expect(w).toMatchObject({ host_id: 'lab', account_no: no, epoch: 1, version: '0.14.0', vnc_port: 5901, last_heartbeat_at: null });

    // The token admits the worker; nothing secret is in it.
    const hb = await heartbeat(a.worker_token, 'HEALTHY');
    expect(hb.status).toBe(200);
    expect(hb.body).toEqual({ ok: true, directives: [] });
    const claims = JSON.parse(Buffer.from(a.worker_token.split('.')[0], 'base64url').toString());
    expect(claims).toMatchObject({ worker_id: 'lab-1', account_no: no, epoch: 1 });
  });

  it('never hands one slot to two concurrent claims', async () => {
    await seedSlot(1);
    await seedSlot(2);
    const results = await Promise.all([claim('lab-1'), claim('lab-2'), claim('other-1', OTHER_HOST_TOKEN, 'other')]);
    const won = results.filter((r) => r.status === 200);
    const lost = results.filter((r) => r.status === 409);
    expect(won).toHaveLength(2);
    expect(lost).toHaveLength(1);
    expect(lost[0].body).toEqual({ error: 'no_slot' });
    expect(new Set(won.map((r) => r.body.account.no)).size).toBe(2);
    expect(won.map((r) => r.body.epoch)).toEqual([1, 1]);
  });

  it('prefers the slot that last ran on this host, then home cities nobody covers', async () => {
    const elsewhere = await seedSlot(1, { lastHost: 'other', home: ['nyc', 'denver'] });
    const here = await seedSlot(2, { lastHost: 'lab' });
    const uncovered = await seedSlot(3, { home: ['houston'] });
    const covered = await seedSlot(4, { home: ['nyc'] });
    expect((await claimed('lab-1')).account.no).toBe(here);
    // nyc is covered by #1 only once #1 runs; with nobody running, #1's two
    // uncovered cities beat #3's one.
    expect((await claimed('lab-2')).account.no).toBe(elsewhere);
    expect((await claimed('lab-3')).account.no).toBe(uncovered);
    expect((await claimed('lab-4')).account.no).toBe(covered);
    expect((await claim('lab-5')).status).toBe(409);
  });

  it('skips accounts that left the fleet, parked slots and live leases, and takes an expired one with the next epoch', async () => {
    await seedSlot(1, { status: 'problem' });
    const parked = await seedSlot(2);
    await getTestDb()`UPDATE fleet_slots SET lease_expires_at = 'infinity' WHERE account_no = ${parked}`;
    const live = await seedSlot(3);
    const first = await claimed('lab-1');
    expect(first.account.no).toBe(live);
    expect((await claim('lab-2')).status).toBe(409);
    await getTestDb()`UPDATE fleet_slots SET lease_expires_at = NOW() - interval '1 second' WHERE account_no = ${live}`;
    const second = await claimed('lab-2');
    expect(second.account.no).toBe(live);
    expect(second.epoch).toBe(2);
    // The first worker is fenced out everywhere.
    expect((await heartbeat(first.worker_token, 'HEALTHY')).status).toBe(409);
  });

  it('is host scope and checks the body', async () => {
    await seedSlot(1);
    expect((await claim('lab-1', 'nope')).status).toBe(401);
    const mismatch = await claim('lab-1', HOST_TOKEN, 'other');
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error).toBe('bad_request');
    expect((await api('POST', '/api/fleet/worker/claim', { headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id: 'bad id!', version: '1' } })).status).toBe(422);
    // A worker token is not a host token.
    const wt = signWorkerToken({ worker_id: 'x', account_no: 1, epoch: 0, exp: Math.floor(Date.now() / 1000) + 60 }, workerTokenKey(testEnv)!);
    expect((await claim('lab-1', wt)).status).toBe(401);
  });

  it('needs no CSRF header: the worker has no cookie to forge', async () => {
    await seedSlot(1);
    const r = await claim('lab-1', HOST_TOKEN, 'lab', { 'X-Requested-By': 'a-python-container' });
    expect(r.status).toBe(200);
  });

  it('reads a cookie the pool holds as JSON, and a storage state', () => {
    const json = JSON.stringify([{ name: 'c_user', value: '1', domain: '.facebook.com', path: '/', expires: 1.5e9, httpOnly: false, secure: true, sameSite: 'None' }]);
    expect(cookiesFromText(json)).toEqual([{ name: 'c_user', value: '1', domain: '.facebook.com', path: '/', expires: 1.5e9, httpOnly: false, secure: true, sameSite: 'None' }]);
    expect(cookiesFromText(JSON.stringify({ cookies: [{ name: 'xs', value: 'v' }], origins: [] }))).toEqual([{ name: 'xs', value: 'v', domain: '.facebook.com', path: '/' }]);
    expect(cookiesFromText('')).toEqual([]);
    expect(cookiesFromText('{not json')).toEqual([]);
  });
});

describe('the worker routes with a stale epoch', () => {
  beforeEach(async () => { await resetDb(); await seedBase(); });

  it('answer 409 stale_epoch on heartbeat, next-task, events and session once the slot moved on', async () => {
    const no = await seedSlot(1);
    const old = await claimed('lab-1');
    await getTestDb()`UPDATE fleet_slots SET lease_expires_at = NOW() - interval '1 second' WHERE account_no = ${no}`;
    await claimed('lab-2');
    const stale = old.worker_token;
    const h = bearer(stale);
    for (const r of await Promise.all([
      api('POST', '/api/fleet/worker/heartbeat', { headers: h, body: { state: 'HEALTHY' } }),
      api('POST', '/api/fleet/worker/next-task', { headers: h, body: { done: null, wait: 0 } }),
      api('POST', '/api/fleet/worker/next-task', { headers: h, body: { done: { task_id: 1, result: {} }, wait: 0, take: false } }),
      api('POST', '/api/fleet/worker/events', { headers: h, body: { task_id: 1, kind: 'started' } }),
      api('PUT', '/api/fleet/worker/session', { headers: h, body: { cookies: [] } }),
    ])) {
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'stale_epoch' });
    }
  });

  it('answer 409 when the slot moved on during a held poll', async () => {
    const no = await seedSlot(1);
    const old = await claimed('lab-1');
    const held = nextTask(old.worker_token, null, 2);
    await new Promise((r) => setTimeout(r, 200));
    await getTestDb()`UPDATE fleet_slots SET lease_expires_at = NOW() - interval '1 second' WHERE account_no = ${no}`;
    await claimed('lab-2');
    await addTask('houston');
    await notifyReady(getTestDb(), ['server_ram']);
    const r = await held;
    expect(r.status).toBe(409);
    // The task went to nobody stale.
    const [t] = await getTestDb()<{ state: string }[]>`SELECT state FROM fleet_tasks`;
    expect(t.state).toBe('ready');
  });
});

describe('POST /api/fleet/worker/next-task', () => {
  beforeEach(async () => { await resetDb(); await seedBase(); });

  it('hands the due task, leases it with the epoch, closes it on done and hands the next', async () => {
    const no = await seedSlot(1);
    const { worker_token: token, epoch } = await claimed('lab-1');
    const empty = await nextTask(token);
    expect(empty.body).toEqual({ task: null, retry_after: 30, reason: 'nothing_due' });

    const first = await addTask('houston');
    const second = await addTask('denver', 'enterprise_ssd', { due_at: new Date(Date.now() + 60_000).toISOString() });
    const r1 = await nextTask(token);
    expect(r1.status).toBe(200);
    expect(r1.body.task).toMatchObject({ id: first, kind: 'search', city: { slug: 'houston', name: 'Houston', radius_km: 500 }, item: 'server_ram', why: 'other' });
    expect(await taskRow(first)).toMatchObject({ state: 'leased', worker_id: 'lab-1', account_no: no, epoch });
    expect(await events(first)).toEqual(['handed']);
    // denver is not due yet.
    expect((await nextTask(token)).body.task).toBeNull();

    await getTestDb()`UPDATE fleet_tasks SET due_at = NOW() WHERE id = ${second}`;
    const result = { cards: 115, opened: 9, reviewed: 9, alerted: 1, seconds: 412 };
    const r2 = await nextTask(token, { task_id: first, result });
    expect(r2.body.task).toMatchObject({ id: second, item: 'enterprise_ssd' });
    const done = await taskRow(first);
    expect(done).toMatchObject({ state: 'done', result });
    expect(done.done_at).toBeInstanceOf(Date);
    expect(await events(first)).toEqual(['handed', 'done']);
  });

  it('orders by priority, then home, familiar, other, then due', async () => {
    const no = await seedSlot(1, { home: ['nyc'] });
    const { worker_token: token } = await claimed('lab-1');
    // denver is familiar: this account searched it two days ago.
    await getTestDb()`
      INSERT INTO fleet_tasks (city, item, due_at, state, account_no, leased_at, done_at)
      VALUES ('denver', 'server_ram', NOW() - interval '2 days', 'done', ${no}, NOW() - interval '2 days', NOW() - interval '2 days')`;
    const other = await addTask('houston', 'server_ram', { due_at: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    const familiar = await addTask('denver', 'server_ram', { due_at: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    const home = await addTask('nyc', 'server_ram', { due_at: new Date(Date.now() - 3_600_000).toISOString() });
    // On denver, which is familiar already: a done manual task would otherwise make its city familiar too.
    const manual = await addTask('denver', 'enterprise_ssd', { priority: 100, reason: 'manual' });

    const order: Array<[number, string]> = [];
    let done: unknown = null;
    for (let i = 0; i < 4; i++) {
      const r = await nextTask(token, done);
      const t = r.body.task!;
      order.push([t.id, t.why]);
      done = { task_id: t.id, result: {} };
    }
    expect(order).toEqual([[manual, 'manual'], [home, 'home'], [familiar, 'familiar'], [other, 'other']]);
  });

  it('wakes a held poll within a second of a manager\u2019s search-now', async () => {
    await seedSlot(1);
    const { worker_token: token } = await claimed('lab-1');
    const manager = await loginAs(ALEX);
    const held = nextTask(token, null, 10);
    await new Promise((r) => setTimeout(r, 300));
    const asked = Date.now();
    const made = await api<{ id: number }>('POST', '/api/fleet/tasks', { token: manager.token, body: { city: 'houston', item: 'server_ram' } });
    expect(made.status).toBe(201);
    const r = await held;
    expect(Date.now() - asked).toBeLessThan(1000);
    expect(r.body.task).toMatchObject({ id: made.body.id, why: 'manual' });
  });

  it('wakes a held poll within a second of a manager adding a city, with its slug check', async () => {
    await seedSlot(1);
    const { worker_token: token } = await claimed('lab-1');
    const manager = await loginAs(ALEX);
    const held = nextTask(token, null, 10);
    await new Promise((r) => setTimeout(r, 300));
    const asked = Date.now();
    const made = await api('POST', '/api/fleet/cities', { token: manager.token, body: { slug: 'austin', name: 'Austin' } });
    expect(made.status).toBe(201);
    const r = await held;
    expect(Date.now() - asked).toBeLessThan(1000);
    expect(r.body.task).toMatchObject({ kind: 'verify-slug', city: { slug: 'austin' } });
  });

  it('a notify sent inside a transaction wakes the poll only once the task has committed', async () => {
    await seedSlot(1);
    const { worker_token: token } = await claimed('lab-1');
    const held = nextTask(token, null, 5);
    await new Promise((r) => setTimeout(r, 300));
    let id = 0;
    await getTestDb().begin(async (tx) => {
      const [t] = await tx<{ id: number }[]>`
        INSERT INTO fleet_tasks (city, item, kind, due_at, priority, state, reason)
        VALUES ('houston', 'server_ram', 'search', NOW(), 0, 'ready', 'cadence') RETURNING id::int AS id`;
      id = t.id;
      await notifyReady(tx, ['server_ram']);
      await new Promise((r) => setTimeout(r, 400));
    });
    expect((await held).body.task).toMatchObject({ id });
  });

  it('caps the hold at poll_hold_seconds and answers null after it', async () => {
    await seedSlot(1);
    await getTestDb()`INSERT INTO fleet_settings (key, value) VALUES ('poll_hold_seconds', '1')`;
    const { worker_token: token, settings } = await claimed('lab-1');
    expect(settings.poll_hold_seconds).toBe(1);
    const started = Date.now();
    const r = await nextTask(token, null, 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(r.body).toEqual({ task: null, retry_after: 30, reason: 'nothing_due' });
  });

  it('answers budget once today’s leased minutes reach budget_minutes', async () => {
    const no = await seedSlot(1);
    const { worker_token: token } = await claimed('lab-1');
    const waiting = await addTask('houston');
    // Minutes belong to the lease's UTC date, even when CI runs before 07:00 UTC.
    await getTestDb()`
      WITH today AS (
        SELECT date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start
      )
      INSERT INTO fleet_tasks (city, item, due_at, state, account_no, leased_at, lease_expires_at, done_at)
      SELECT 'denver', 'server_ram', start, 'done', ${no}, start,
             start + interval '30 minutes', start + interval '7 hours'
      FROM today`;
    const r = await nextTask(token, null, 5);
    expect(r.body).toEqual({ task: null, retry_after: 300, reason: 'budget' });
    expect((await taskRow(waiting)).state).toBe('ready');
  });

  it('take:false closes done and leases nothing, even with a task due, and answers at once', async () => {
    const no = await seedSlot(1);
    const { worker_token: token } = await claimed('lab-1');
    const first = await addTask('houston');
    expect((await nextTask(token)).body.task).toMatchObject({ id: first });
    const waiting = await addTask('denver');
    const result = { cards: 3, opened: 0, reviewed: 0, alerted: 0, seconds: 5 };
    const started = Date.now();
    const r = await api<NextTaskAnswer>('POST', '/api/fleet/worker/next-task', {
      headers: bearer(token), body: { done: { task_id: first, result }, wait: 10, take: false },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ task: null, reason: 'done_only' });
    expect(await taskRow(first)).toMatchObject({ state: 'done', result });
    expect(await events(first)).toEqual(['handed', 'done']);
    expect(await taskRow(waiting)).toMatchObject({ state: 'ready', worker_id: null });
    expect(await events(waiting)).toEqual([]);
    // Without done it still takes nothing; budget and quarantine are not consulted.
    await getTestDb()`UPDATE fleet_slots SET quarantined_until = NOW() + interval '1 hour' WHERE account_no = ${no}`;
    const bare = await api<NextTaskAnswer>('POST', '/api/fleet/worker/next-task', { headers: bearer(token), body: { done: null, wait: 10, take: false } });
    expect(bare.body).toEqual({ task: null, reason: 'done_only' });
    expect((await taskRow(waiting)).state).toBe('ready');
  });

  it('takes as before when take is omitted or true, and refuses a take that is not a boolean', async () => {
    await seedSlot(1);
    const { worker_token: token } = await claimed('lab-1');
    const first = await addTask('houston');
    const second = await addTask('denver');
    expect((await nextTask(token)).body.task).toMatchObject({ id: first });
    const r = await api<NextTaskAnswer>('POST', '/api/fleet/worker/next-task', {
      headers: bearer(token), body: { done: { task_id: first, result: {} }, wait: 0, take: true },
    });
    expect(r.body.task).toMatchObject({ id: second });
    const bad = await api<{ error: string; detail?: string }>('POST', '/api/fleet/worker/next-task', {
      headers: bearer(token), body: { done: { task_id: second, result: {} }, wait: 0, take: 'no' },
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toEqual({ error: 'bad_request', detail: 'take' });
    expect((await taskRow(second)).state).toBe('leased');
  });

  it('hands a quarantined slot only its own probe, and a healthy worker any search or slug check', async () => {
    const quarantined = await seedSlot(1, { quarantinedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    const healthy = await seedSlot(2);
    const q = await claimed('lab-1');
    const h = await claimed('lab-2');
    expect(q.account.no).toBe(quarantined);
    expect(h.account.no).toBe(healthy);
    const search = await addTask('houston');
    const verify = await addTask('boise', 'server_ram', { kind: 'verify-slug', reason: 'verify', priority: 50 });
    expect((await nextTask(q.worker_token, null, 1)).body).toEqual({ task: null, retry_after: 300, reason: 'quarantined' });
    const probe = await addTask('denver', 'server_ram', { kind: 'probe', reason: 'probe', account_no: quarantined });
    expect((await nextTask(q.worker_token)).body.task).toMatchObject({ id: probe, kind: 'probe', why: 'probe' });
    // The healthy worker never sees the probe; it takes the slug check (priority 50) then the search.
    expect((await nextTask(h.worker_token)).body.task).toMatchObject({ id: verify, kind: 'verify-slug' });
    expect((await nextTask(h.worker_token)).body.task).toMatchObject({ id: search });
  });
});

describe('POST /api/fleet/worker/heartbeat', () => {
  beforeEach(async () => { await resetDb(); await seedBase(); });

  it('renews the slot lease, records the worker, and HEALTHY renews the task lease', async () => {
    const no = await seedSlot(1);
    const { worker_token: token } = await claimed('lab-1');
    const id = await addTask('houston');
    await nextTask(token);
    const db = getTestDb();
    await db`UPDATE fleet_slots SET lease_expires_at = NOW() + interval '1 minute' WHERE account_no = ${no}`;
    await db`UPDATE fleet_tasks SET lease_expires_at = NOW() + interval '1 minute' WHERE id = ${id}`;
    const r = await heartbeat(token, 'HEALTHY', { detail: { page: 'marketplace' }, last_search_at: '2026-10-24T12:00:00Z' });
    expect(r.status).toBe(200);
    const [slot] = await db<{ lease_expires_at: Date }[]>`SELECT lease_expires_at FROM fleet_slots WHERE account_no = ${no}`;
    expect(slot.lease_expires_at.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    const t = await taskRow(id);
    expect((t.lease_expires_at as Date).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect(t.state).toBe('leased');
    const [w] = await db<Record<string, unknown>[]>`SELECT * FROM fleet_workers WHERE worker_id = 'lab-1'`;
    expect(w).toMatchObject({ state: 'HEALTHY', version: '0.14.0', vnc_port: 5901, host_id: 'lab', account_no: no, detail: { page: 'marketplace', last_search_at: '2026-10-24T12:00:00Z' } });
    expect(w.last_heartbeat_at).toBeInstanceOf(Date);
  });

  it('releases the task on a parked state, and keeps it on DEGRADED', async () => {
    await seedSlot(1);
    const { worker_token: token } = await claimed('lab-1');
    const id = await addTask('houston');
    await nextTask(token);
    expect((await heartbeat(token, 'DEGRADED')).status).toBe(200);
    expect(await taskRow(id)).toMatchObject({ state: 'leased', worker_id: 'lab-1' });
    expect(await events(id)).toEqual(['handed']);

    expect((await heartbeat(token, 'CHALLENGE_CHECKPOINT')).status).toBe(200);
    const t = await taskRow(id);
    expect(t).toMatchObject({ state: 'ready', worker_id: null, account_no: null, epoch: null, leased_at: null, lease_expires_at: null });
    expect((t.due_at as Date).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await events(id)).toEqual(['handed', 'released']);
    const [ev] = await getTestDb()<{ detail: unknown; worker_id: string }[]>`SELECT detail, worker_id FROM fleet_task_events WHERE task_id = ${id} AND kind = 'released'`;
    expect(ev).toEqual({ detail: { reason: 'CHALLENGE_CHECKPOINT' }, worker_id: 'lab-1' });
    // The slot's lease still renews: the account stays with this worker until a human acts.
    const [w] = await getTestDb()<{ state: string }[]>`SELECT state FROM fleet_workers WHERE worker_id = 'lab-1'`;
    expect(w.state).toBe('CHALLENGE_CHECKPOINT');
  });

  it('refuses a body without a state', async () => {
    await seedSlot(1);
    const { worker_token: token } = await claimed('lab-1');
    expect((await api('POST', '/api/fleet/worker/heartbeat', { headers: bearer(token), body: {} })).status).toBe(422);
  });
});

describe('POST /api/fleet/worker/events', () => {
  beforeEach(async () => { await resetDb(); await seedBase(); });

  it('appends to the task’s log, stamps started_at, and refuses another worker’s task', async () => {
    await seedSlot(1);
    await seedSlot(2);
    const a = await claimed('lab-1');
    const b = await claimed('lab-2');
    const id = await addTask('houston');
    expect((await nextTask(a.worker_token)).body.task).toMatchObject({ id });
    const post = (token: string, body: unknown) => api('POST', '/api/fleet/worker/events', { headers: bearer(token), body });
    expect((await post(a.worker_token, { task_id: id, kind: 'started' })).status).toBe(200);
    expect((await post(a.worker_token, { task_id: id, kind: 'searched', detail: { phrase: 'server ram', cards: 60 } })).status).toBe(200);
    expect((await post(b.worker_token, { task_id: id, kind: 'started' })).status).toBe(404);
    expect((await post(a.worker_token, { task_id: id, kind: 'handed' })).status).toBe(422);
    expect((await post(a.worker_token, { task_id: 9999, kind: 'started' })).status).toBe(404);
    expect(await events(id)).toEqual(['handed', 'started', 'searched']);
    expect((await taskRow(id)).started_at).toBeInstanceOf(Date);
  });

  it('a verify-slug result enables the city when the label matches, and leaves it disabled otherwise', async () => {
    await seedSlot(1);
    const { worker_token: token } = await claimed('lab-1');
    const post = (body: unknown) => api('POST', '/api/fleet/worker/events', { headers: bearer(token), body });
    const city = async (slug: string) => (await getTestDb()<Record<string, unknown>[]>`SELECT * FROM fleet_cities WHERE slug = ${slug}`)[0];

    const miss = await addTask('boise', 'server_ram', { kind: 'verify-slug', reason: 'verify', priority: 50 });
    expect((await nextTask(token)).body.task).toMatchObject({ id: miss });
    expect((await post({ task_id: miss, kind: 'finished', detail: { location: 'Boston, MA', matches: false } })).status).toBe(200);
    expect(await city('boise')).toMatchObject({ enabled: false, verified_as: 'Boston, MA' });
    expect((await city('boise')).verified_at).toBeInstanceOf(Date);

    await nextTask(token, { task_id: miss, result: {} });
    const hit = await addTask('boise', 'server_ram', { kind: 'verify-slug', reason: 'verify', priority: 50 });
    expect((await nextTask(token)).body.task).toMatchObject({ id: hit });
    expect((await post({ task_id: hit, kind: 'finished', detail: { location: 'Boise, Idaho', matches: true } })).status).toBe(200);
    expect(await city('boise')).toMatchObject({ enabled: true, verified_as: 'Boise, Idaho', disabled_at: null });
  });
});

describe('PUT /api/fleet/worker/session', () => {
  beforeEach(async () => { await resetDb(); await seedBase(); });

  it('reseals the cookies and token into the pool row and stamps cookie_at', async () => {
    const no = await seedSlot(1, { uid: '61550000000099' });
    const { worker_token: token } = await claimed('lab-1');
    const cookies: FleetCookie[] = [
      { name: 'c_user', value: '61550000000099', domain: '.facebook.com', path: '/', expires: 1_800_000_000, httpOnly: false, secure: true, sameSite: 'None' },
      { name: 'xs', value: 'new-xs', domain: '.facebook.com', path: '/', httpOnly: true, secure: true, sameSite: 'None' },
    ];
    const r = await api('PUT', '/api/fleet/worker/session', { headers: bearer(token), body: { cookies, token: 'EAA-new' } });
    expect(r.status).toBe(200);
    const [row] = await getTestDb()<{ cookie_enc: string; cookie_uid: string; cookie_at: Date; token_enc: string }[]>`
      SELECT cookie_enc, cookie_uid, cookie_at, token_enc FROM fb_pool_accounts WHERE no = ${no}`;
    expect(JSON.parse(unseal(row.cookie_enc, key()))).toEqual(cookies);
    expect(row.cookie_uid).toBe('61550000000099');
    expect(row.cookie_at).toBeInstanceOf(Date);
    expect(unseal(row.token_enc, key())).toBe('EAA-new');
    // The next claim hands back exactly what was stored.
    await getTestDb()`UPDATE fleet_slots SET lease_expires_at = NOW() - interval '1 second' WHERE account_no = ${no}`;
    const again = await claimed('lab-2');
    expect(again.account.cookies).toEqual(cookies);
    expect(again.account.token).toBe('EAA-new');
    // Leaving `token` out keeps it; null clears it.
    expect((await api('PUT', '/api/fleet/worker/session', { headers: bearer(again.worker_token), body: { cookies } })).status).toBe(200);
    expect((await getTestDb()<{ token_enc: string | null }[]>`SELECT token_enc FROM fb_pool_accounts WHERE no = ${no}`)[0].token_enc).not.toBeNull();
    expect((await api('PUT', '/api/fleet/worker/session', { headers: bearer(again.worker_token), body: { cookies, token: null } })).status).toBe(200);
    expect((await getTestDb()<{ token_enc: string | null }[]>`SELECT token_enc FROM fb_pool_accounts WHERE no = ${no}`)[0].token_enc).toBeNull();
    expect((await api('PUT', '/api/fleet/worker/session', { headers: bearer(again.worker_token), body: { cookies: 'nope' } })).status).toBe(422);
  });
});
