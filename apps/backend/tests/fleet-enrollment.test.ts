import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fleetCloakFor, fleetDeviceFor, FLEET_CLOAK_MIN_WORKER_VERSION, FLEET_EXIT_FRESH_MS,
  type ClaimAnswer, type FleetProxy, type FleetProxyHealthAnswer, type FleetSettings, type FleetSlot,
} from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { ALEX, loginAs } from './helpers/auth';
import { sha256hex } from '../src/fleet/sql';
import { poolKey, seal } from '../src/lib/sealed';
import workerModule from '../../../deploy/cloudflare/worker.js';

// Atomic enrollment, the profile that outlives a slot, and reservation by
// measured exit IP. Every account, proxy, IP and key here is made up.

const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const LICENCE = 'cb_made_up_' + randomBytes(8).toString('hex');
const bearer = { Authorization: `Bearer ${HOST_TOKEN}` };

type Err = { error: string; detail?: string };
type Added = { slot: FleetSlot } & Err;
type EnrollmentRow = {
  account_no: number; uid: string; batch: string; pilot_id: string | null; arm: string; seed: number | null;
  exit_ip: string; enrolled_at: Date; first_claimed_at: Date | null; enrolled_by: string | null;
};

let token: string;
let logged: string[];

async function account(n: number, o: { session?: boolean } = {}): Promise<number> {
  const k = poolKey(testEnv)!;
  const uid = `6157000000000${n}`;
  const [a] = await getTestDb()<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, password_enc, totp_enc, cookie_enc)
    VALUES (${uid}, 'Order 7', 'available', ${seal(`pw-${n}`, k)}, ${seal('ABCDEFGH', k)}, ${o.session ? seal(`c_user=${uid}; xs=x`, k) : null})
    RETURNING no`;
  return a.no;
}

async function proxy(port: number, timezone = 'America/New_York'): Promise<number> {
  const r = await api<FleetProxy>('POST', '/api/fleet/proxies', {
    token, body: { label: `P${port}`, url: `http://u:p@isp.example.net:${port}`, timezone },
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

const measure = (proxyId: number, ip: string | null, o: { ok?: boolean; agoMs?: number; zone?: string | null } = {}) => getTestDb()`
  INSERT INTO fleet_proxy_checks (exit, source, proxy_id, checked_at, ok, latency_ms, exit_ip, timezone)
  VALUES ('http://isp.example.net', 'erp', ${proxyId}, NOW() - make_interval(secs => ${(o.agoMs ?? 0) / 1000}), ${o.ok ?? true}, 300, ${ip},
          ${o.zone === undefined ? (ip && (o.ok ?? true) ? 'America/New_York' : null) : o.zone})`;

const add = (body: Record<string, unknown>) => api<Added>('POST', '/api/fleet/slots', { token, body });
const enroll = (no: number, proxyId: number, arm: 'cloak' | 'stock' = 'cloak', pilot = 'wave-1') =>
  add({ account_no: no, proxy_id: proxyId, pilot, arm });
const setSettings = async (body: Partial<FleetSettings>) =>
  expect((await api('PUT', '/api/fleet/settings', { token, body })).status).toBe(200);
const claim = (workerId: string) => api<ClaimAnswer & Err>('POST', '/api/fleet/worker/claim', {
  headers: bearer, body: { host_id: 'lab', worker_id: workerId, version: FLEET_CLOAK_MIN_WORKER_VERSION, vnc_port: 5901 },
});
const enrollment = async (no: number) =>
  (await getTestDb()<EnrollmentRow[]>`SELECT * FROM fleet_pilot_enrollments WHERE account_no = ${no}`)[0];
const profile = async (no: number) => (await getTestDb()<{ browser_engine: string | null; cloak_seed: number | null; cloak_gpu: string | null; profile_timezone: string | null }[]>`
  SELECT browser_engine, cloak_seed, cloak_gpu, profile_timezone FROM fb_pool_accounts WHERE no = ${no}`)[0];
const parkAndRemove = async (no: number) => {
  expect((await api('POST', `/api/fleet/slots/${no}/park`, { token })).status).toBe(200);
  expect((await api('POST', `/api/fleet/slots/${no}/remove`, { token })).status).toBe(200);
};

beforeEach(async () => {
  await resetDb();
  await getTestDb()`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 8, TRUE)`;
  token = (await loginAs(ALEX)).token;
  await setSettings({ cloak_enabled: true, cloak_max_slots: 10 });
  logged = [];
  const capture = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
});

afterEach(() => {
  for (const line of logged) expect(line).not.toContain(LICENCE);
  vi.restoreAllMocks();
});

describe('POST /api/fleet/slots with pilot and arm', () => {
  it('writes enrollment, profile, proxy and slot together', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await measure(p, '198.51.100.1');
    const r = await enroll(no, p);
    expect(r.status).toBe(201);
    const fp = fleetCloakFor(no);
    expect(r.body.slot).toMatchObject({ account_no: no, proxy_id: p, has_proxy: true });
    expect(r.body.slot.device).toEqual({ ...fleetDeviceFor(no, 'America/New_York'), browser_engine: 'cloak', ...fp });
    expect(await profile(no)).toEqual({ browser_engine: 'cloak', ...fp, profile_timezone: 'America/New_York' });
    expect(await enrollment(no)).toMatchObject({
      uid: '61570000000001', batch: 'Order 7', pilot_id: 'wave-1', arm: 'cloak', seed: fp.cloak_seed,
      exit_ip: '198.51.100.1', first_claimed_at: null, enrolled_by: ALEX,
    });
  });

  it('enrolls a stock arm with no seed and a pinned clock, and engine alone outside a pilot', async () => {
    const [a, b] = [await account(1), await account(2)];
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.2');
    const stock = await enroll(a, p, 'stock');
    expect(stock.status).toBe(201);
    expect(stock.body.slot.device).toEqual({ ...fleetDeviceFor(a, 'America/New_York'), browser_engine: 'stock' });
    expect(await profile(a)).toEqual({ browser_engine: 'stock', cloak_seed: null, cloak_gpu: null, profile_timezone: 'America/New_York' });
    expect(await enrollment(a)).toMatchObject({ arm: 'stock', seed: null });
    expect((await add({ account_no: b, proxy_id: q, engine: 'cloak' })).status).toBe(201);
    expect(await enrollment(b)).toMatchObject({ pilot_id: null, arm: 'cloak', seed: fleetCloakFor(b).cloak_seed });
  });

  it('validates the new fields', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    for (const body of [
      { pilot: 'w' }, { arm: 'cloak' }, { pilot: 'w', arm: 'firefox' }, { engine: 'firefox' },
      { pilot: 'w', arm: 'cloak', engine: 'stock' }, { pilot: 'bad name', arm: 'cloak' }, { pilot: '', arm: 'cloak' },
    ]) {
      const r = await add({ account_no: no, proxy_id: p, ...body });
      expect(r.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('without the new fields, stays exactly as it was: no enrollment, no profile, no measurement needed', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    const r = await add({ account_no: no, proxy_id: p });
    expect(r.status).toBe(201);
    expect(r.body.slot.device).toEqual(fleetDeviceFor(no, 'America/New_York'));
    expect(await enrollment(no)).toBeUndefined();
    expect(await profile(no)).toEqual({ browser_engine: null, cloak_seed: null, cloak_gpu: null, profile_timezone: null });
    const answer = await claim('lab-1');
    expect(answer.status).toBe(200);
    expect(answer.body).not.toHaveProperty('expected_exit_ip');
    expect(answer.body).not.toHaveProperty('webrtc_ip');
    expect(answer.body).not.toHaveProperty('env');
  });

  it('never lets a claim see a half-set slot while enrollments race claims', async () => {
    const nos = await Promise.all(Array.from({ length: 6 }, (_, i) => account(i + 1)));
    const proxies = await Promise.all(nos.map((_, i) => proxy(10001 + i)));
    await Promise.all(proxies.map((p, i) => measure(p, `198.51.100.${i + 1}`)));
    const seen: ClaimAnswer[] = [];
    const claims = nos.flatMap((_, i) => Array.from({ length: 4 }, async (_x, attempt) => {
      await new Promise((r) => setTimeout(r, attempt * 5));
      const a = await claim(`lab-${i + 1}`);
      if (a.status === 200) seen.push(a.body);
    }));
    const enrollments = nos.map((no, i) => enroll(no, proxies[i]));
    const results = await Promise.all(enrollments);
    await Promise.all(claims);
    expect(results.map((r) => r.status)).toEqual(nos.map(() => 201));
    // Whatever got claimed mid-race came with its whole profile.
    for (const a of seen) {
      expect(a.device).toMatchObject({ browser_engine: 'cloak', ...fleetCloakFor(a.account.no) });
      expect(a.expected_exit_ip).toMatch(/^198\.51\.100\./);
      expect(await enrollment(a.account.no)).toBeDefined();
    }
    // And no stock-shaped device on any row.
    const stock = await getTestDb()`SELECT 1 FROM fleet_slots WHERE device->>'browser_engine' IS DISTINCT FROM 'cloak'`;
    expect(stock).toHaveLength(0);
  });

  it('holds the claim off until the transaction commits, then hands out all of it', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await measure(p, '198.51.100.1');
    const db = getTestDb();
    // A held proxy lock stops the enrollment midway, with the pool row taken.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = db.begin(async (tx) => {
      await tx`SELECT id FROM fleet_proxies WHERE id = ${p} FOR UPDATE`;
      locked();
      await held;
    });
    await isLocked;
    const pending = enroll(no, p);
    await vi.waitFor(async () => {
      const waiting = await db`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE '%fleet_proxies%'`;
      expect(waiting.length).toBeGreaterThan(0);
    });
    const during = await claim('lab-1');
    expect(during.status).toBe(409);
    expect(during.body.error).toBe('no_slot');
    release();
    await holder;
    expect((await pending).status).toBe(201);
    const after = await claim('lab-1');
    expect(after.status).toBe(200);
    expect(after.body.device).toMatchObject({ browser_engine: 'cloak', ...fleetCloakFor(no) });
    expect(after.body.expected_exit_ip).toBe('198.51.100.1');
  });

  it('a refusal leaves nothing behind', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await setSettings({ cloak_enabled: false });
    await measure(p, '198.51.100.1');
    expect((await enroll(no, p)).body.error).toBe('cloak_disabled');
    const db = getTestDb();
    expect(await db`SELECT 1 FROM fleet_slots WHERE account_no = ${no}`).toHaveLength(0);
    expect(await enrollment(no)).toBeUndefined();
    expect(await profile(no)).toEqual({ browser_engine: null, cloak_seed: null, cloak_gpu: null, profile_timezone: null });
    expect((await db<{ status: string }[]>`SELECT status FROM fb_pool_accounts WHERE no = ${no}`)[0].status).toBe('available');
  });

  it('refuses CloakBrowser for an account a stock worker left a session on, unless it was lost', async () => {
    const no = await account(1, { session: true });
    const p = await proxy(10001);
    await measure(p, '198.51.100.1');
    const db = getTestDb();
    await db`INSERT INTO fb_pool_events (account_no, actor_id, actor_name, kind, status, detail)
             VALUES (${no}, NULL, 'fleet host lab', 'assigned', 'fleet', 'lab-1')`;
    expect((await enroll(no, p)).body.error).toBe('engine_live_session');
    await db`INSERT INTO fleet_worker_state_events (account_no, worker_id, engine, from_state, to_state)
             VALUES (${no}, 'lab-1', 'stock', 'HEALTHY', 'CHECKPOINT')`;
    expect((await enroll(no, p)).status).toBe(201);
  });
});

describe('the profile outlives the slot', () => {
  it('re-adding keeps engine, seed, GPU and clock, on another proxy with another zone', async () => {
    const no = await account(1);
    const [ny, chi] = [await proxy(10001), await proxy(10002, 'America/Chicago')];
    await measure(ny, '198.51.100.1');
    await measure(chi, '198.51.100.2');
    expect((await enroll(no, ny)).status).toBe(201);
    const first = await enrollment(no);
    await parkAndRemove(no);
    expect(await profile(no)).toMatchObject({ browser_engine: 'cloak', cloak_seed: fleetCloakFor(no).cloak_seed });
    const r = await add({ account_no: no, proxy_id: chi });
    expect(r.status).toBe(201);
    expect(r.body.slot.device).toEqual({ ...fleetDeviceFor(no, 'America/New_York'), browser_engine: 'cloak', ...fleetCloakFor(no) });
    // Never claimed, so the re-add records the exit it now goes out on.
    expect(await enrollment(no)).toEqual({ ...first, exit_ip: '198.51.100.2' });
  });

  it('keeps the cloak_seeded guard past remove and re-add', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await measure(p, '198.51.100.1');
    expect((await add({ account_no: no, proxy_id: p })).status).toBe(201);
    const engine = (e: string) => api<Err>('POST', `/api/fleet/slots/${no}/engine`, { token, body: { engine: e } });
    expect((await engine('cloak')).status).toBe(200);
    expect(await profile(no)).toMatchObject({ browser_engine: 'cloak', cloak_seed: fleetCloakFor(no).cloak_seed, profile_timezone: 'America/New_York' });
    expect((await engine('stock')).status).toBe(200);
    expect((await profile(no)).browser_engine).toBe('stock');
    await parkAndRemove(no);
    const back = await add({ account_no: no, proxy_id: p });
    expect(back.status).toBe(201);
    expect(back.body.slot.device).toMatchObject({ browser_engine: 'stock', ...fleetCloakFor(no) });
    const r = await engine('cloak');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cloak_seeded');
    // Nor can a pilot enroll it back in, on either arm.
    await parkAndRemove(no);
    expect((await enroll(no, p)).body.error).toBe('cloak_seeded');
    expect((await enroll(no, p, 'stock')).body.error).toBe('cloak_seeded');
  });

  it('applies the seat limit and the off switch to a re-added cloak account', async () => {
    const no = await account(1);
    const other = await account(2);
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.2');
    await setSettings({ cloak_max_slots: 1 });
    expect((await enroll(no, p)).status).toBe(201);
    await parkAndRemove(no);
    expect((await enroll(other, q)).status).toBe(201);
    expect((await add({ account_no: no, proxy_id: p })).body.error).toBe('cloak_slots_full');
    await parkAndRemove(other);
    await setSettings({ cloak_enabled: false });
    expect((await add({ account_no: no, proxy_id: p })).body.error).toBe('cloak_disabled');
  });

  it('holds an account to the pilot and arm it was first given', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await measure(p, '198.51.100.1');
    expect((await enroll(no, p, 'stock')).status).toBe(201);
    await parkAndRemove(no);
    expect((await enroll(no, p, 'cloak')).body.error).toBe('already_enrolled');
    expect((await enroll(no, p, 'stock', 'wave-2')).body.error).toBe('already_enrolled');
    expect((await enroll(no, p, 'stock')).status).toBe(201);
    // The engine switch can't move it out of its arm either.
    const r = await api<Err>('POST', `/api/fleet/slots/${no}/engine`, { token, body: { engine: 'cloak' } });
    expect(r.body.error).toBe('pilot_arm');
  });

  it('keeps the enrollment when the account is retired or removed from the pool, and frees the exit', async () => {
    const no = await account(1);
    const next = await account(2);
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.1');
    expect((await enroll(no, p)).status).toBe(201);
    expect((await enroll(next, q)).body.error).toBe('exit_shared');
    expect((await api('POST', `/api/fleet/slots/${no}/park`, { token })).status).toBe(200);
    expect((await api('POST', `/api/fleet/slots/${no}/retire`, { token })).status).toBe(200);
    const db = getTestDb();
    expect(await db`SELECT 1 FROM fleet_slots WHERE account_no = ${no}`).toHaveLength(0);
    expect(await enrollment(no)).toMatchObject({ pilot_id: 'wave-1', arm: 'cloak', exit_ip: '198.51.100.1' });
    expect(await profile(no)).toMatchObject({ browser_engine: 'cloak' });
    expect((await enroll(next, q)).status).toBe(201);
    await db`DELETE FROM fb_pool_accounts WHERE no = ${no}`;
    expect(await enrollment(no)).toMatchObject({ uid: '61570000000001', batch: 'Order 7' });
  });
});

describe('seed uniqueness', () => {
  it('is enforced by the database, whatever the route does', async () => {
    const [a, b] = [await account(1), await account(2)];
    const db = getTestDb();
    await db`UPDATE fb_pool_accounts SET browser_engine = 'cloak', cloak_seed = 12345 WHERE no = ${a}`;
    await expect(db`UPDATE fb_pool_accounts SET browser_engine = 'cloak', cloak_seed = 12345 WHERE no = ${b}`)
      .rejects.toMatchObject({ code: '23505' });
    // A cloak profile with no seed can't exist either.
    await expect(db`UPDATE fb_pool_accounts SET browser_engine = 'cloak' WHERE no = ${b}`).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses the seed another account holds, on enrollment and on the switch', async () => {
    const [a, b, c] = [await account(1), await account(2), await account(3)];
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.2');
    const db = getTestDb();
    // A retired account's fingerprint stays taken too.
    await db`UPDATE fb_pool_accounts SET status = 'retired', browser_engine = 'stock', cloak_seed = ${fleetCloakFor(a).cloak_seed} WHERE no = ${c}`;
    const r = await enroll(a, p);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cloak_seed_taken');
    await db`UPDATE fb_pool_accounts SET cloak_seed = ${fleetCloakFor(b).cloak_seed} WHERE no = ${c}`;
    expect((await add({ account_no: b, proxy_id: q })).status).toBe(201);
    const s = await api<Err>('POST', `/api/fleet/slots/${b}/engine`, { token, body: { engine: 'cloak' } });
    expect(s.status).toBe(409);
    expect(s.body.error).toBe('cloak_seed_taken');
  });
});

describe('reservation by measured exit IP', () => {
  it('refuses an IP a slot already uses through a different port, stock or cloak, parked or not', async () => {
    const [plain, parked, target] = [await account(1), await account(2), await account(3)];
    const [p, q, r] = [await proxy(10001), await proxy(10002), await proxy(10003)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.2');
    await measure(r, '198.51.100.1');
    expect((await add({ account_no: plain, proxy_id: p })).status).toBe(201);
    const shared = await enroll(target, r);
    expect(shared.status).toBe(409);
    expect(shared.body.error).toBe('exit_shared');
    expect(shared.body.detail).toContain(`#${plain}`);
    expect(shared.body.detail).toContain('198.51.100.1');
    // Its latest measurement moved: now r shares with q instead.
    await measure(p, '198.51.100.9');
    await measure(r, '198.51.100.2');
    expect((await add({ account_no: parked, proxy_id: q })).status).toBe(201);
    expect((await api('POST', `/api/fleet/slots/${parked}/park`, { token })).status).toBe(200);
    expect((await enroll(target, r)).body.error).toBe('exit_shared');
    // Free of both, it goes through.
    await measure(r, '198.51.100.3');
    expect((await enroll(target, r)).status).toBe(201);
  });

  it('refuses the IP an active enrollment recorded, even after its port moved', async () => {
    const [a, b] = [await account(1), await account(2)];
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, '198.51.100.1');
    expect((await enroll(a, p)).status).toBe(201);
    await measure(p, '198.51.100.5');
    await measure(q, '198.51.100.1');
    expect((await enroll(b, q)).body.error).toBe('exit_shared');
  });

  it('refuses an IP a homelab worker uses in the last round the console answered', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await measure(p, '198.51.100.1');
    const db = getTestDb();
    const at = new Date(Date.now() - 60_000);
    await db`INSERT INTO fleet_proxy_rounds (started_at, coordinator, coordinator_at) VALUES (${at}, 'ok', ${at})
             ON CONFLICT (id) DO UPDATE SET coordinator = 'ok', coordinator_at = ${at}`;
    const port = (when: Date, workers: string[]) => db`
      INSERT INTO fleet_proxy_checks (exit, source, workers, checked_at, ok, exit_ip)
      VALUES ('http://homelab.example:7000', 'coordinator', ${db.array(workers)}, ${when}, TRUE, '198.51.100.1')`;
    // An older round's worker has moved on; so does a port no worker is on.
    await port(new Date(at.getTime() - 300_000), ['homelab-9']);
    await port(at, []);
    expect((await enroll(no, p)).status).toBe(201);
    await parkAndRemove(no);
    await db`DELETE FROM fleet_proxy_checks WHERE source = 'coordinator'`;
    await port(at, ['homelab-3']);
    const r = await enroll(no, p);
    expect(r.body.error).toBe('exit_shared');
    expect(r.body.detail).toContain('homelab-3');
  });

  it('refuses a measurement that is missing, stale or failing, at the threshold', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    const unmeasured = await enroll(no, p);
    expect(unmeasured.body.error).toBe('exit_stale');
    expect(unmeasured.body.detail).toContain('never');
    expect(FLEET_EXIT_FRESH_MS).toBe(15 * 60_000);
    await measure(p, '198.51.100.1', { agoMs: FLEET_EXIT_FRESH_MS + 5_000 });
    expect((await enroll(no, p)).body.error).toBe('exit_stale');
    await measure(p, null, { ok: false });
    expect((await enroll(no, p)).body.error).toBe('exit_failing');
    // A pass that could not name its IP identifies nothing.
    await measure(p, null, { ok: true });
    expect((await enroll(no, p)).body.error).toBe('exit_failing');
    await measure(p, '198.51.100.1', { agoMs: 0 });
    expect((await enroll(no, p)).status).toBe(201);
  });

  it('judges a re-add and a proxy change of an enrolled account the same way', async () => {
    const [a, b] = [await account(1), await account(2)];
    const [p, q, r] = [await proxy(10001), await proxy(10002), await proxy(10003)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.2');
    await measure(r, '198.51.100.2');
    expect((await enroll(a, p)).status).toBe(201);
    expect((await add({ account_no: b, proxy_id: q })).status).toBe(201);
    const change = (to: number) => api<Err>('POST', `/api/fleet/slots/${a}/proxy`, {
      token, body: { proxy_id: to, from_proxy_id: p, confirm: true },
    });
    expect((await change(r)).body.error).toBe('exit_shared');
    await parkAndRemove(a);
    expect((await add({ account_no: a, proxy_id: r })).body.error).toBe('exit_shared');
    await measure(p, '198.51.100.1', { agoMs: FLEET_EXIT_FRESH_MS * 2 });
    await getTestDb()`DELETE FROM fleet_proxy_checks WHERE proxy_id = ${p} AND checked_at > NOW() - interval '1 minute'`;
    expect((await add({ account_no: a, proxy_id: p })).body.error).toBe('exit_stale');
  });
});

describe('an account outside any pilot and a pilot account\'s exit', () => {
  const change = (no: number, to: number, from: number) => api<Err>('POST', `/api/fleet/slots/${no}/proxy`, {
    token, body: { proxy_id: to, from_proxy_id: from, confirm: true },
  });

  it('refuses a plain add on another port with the pilot account\'s IP', async () => {
    const [pilot, plain] = [await account(1), await account(2)];
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.1');
    expect((await enroll(pilot, p, 'stock')).status).toBe(201);
    const r = await add({ account_no: plain, proxy_id: q });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('exit_shared');
    expect(r.body.detail).toContain(`#${pilot}`);
    expect(await getTestDb()`SELECT 1 FROM fleet_slots WHERE account_no = ${plain}`).toHaveLength(0);
  });

  it('refuses Change proxy for an account that is not enrolled, leaving it where it was', async () => {
    const [pilot, plain] = [await account(1), await account(2)];
    const [p, q, r] = [await proxy(10001), await proxy(10002), await proxy(10003)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.2');
    await measure(r, '198.51.100.1');
    expect((await enroll(pilot, p)).status).toBe(201);
    expect((await add({ account_no: plain, proxy_id: q })).status).toBe(201);
    const refused = await change(plain, r, q);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('exit_shared');
    const [slot] = await getTestDb()<{ proxy_id: number }[]>`SELECT proxy_id FROM fleet_slots WHERE account_no = ${plain}`;
    expect(slot.proxy_id).toBe(q);
  });

  it('matches both the recorded exit and the latest exit of the proxy the slot sits on', async () => {
    const [pilot, plain] = [await account(1), await account(2)];
    const [p, recorded, moved] = [await proxy(10001), await proxy(10002), await proxy(10003)];
    await measure(p, '198.51.100.1');
    expect((await enroll(pilot, p)).status).toBe(201);
    await measure(p, '198.51.100.5');
    await measure(recorded, '198.51.100.1');
    await measure(moved, '198.51.100.5');
    expect((await add({ account_no: plain, proxy_id: recorded })).body.error).toBe('exit_shared');
    expect((await add({ account_no: plain, proxy_id: moved })).body.error).toBe('exit_shared');
  });

  it('judges a failing target by the IP it was last seen on', async () => {
    const [pilot, plain] = [await account(1), await account(2)];
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.1', { agoMs: 60_000 });
    await measure(q, null, { ok: false });
    expect((await enroll(pilot, p)).status).toBe(201);
    expect((await add({ account_no: plain, proxy_id: q })).body.error).toBe('exit_shared');
  });

  it('lets an unmeasured target through, and any IP no pilot account holds', async () => {
    const [pilot, a, b, c] = [await account(1), await account(2), await account(3), await account(4)];
    const [p, unmeasured, other, target] = [await proxy(10001), await proxy(10002), await proxy(10003), await proxy(10004)];
    await measure(p, '198.51.100.1');
    await measure(other, '198.51.100.2');
    await measure(target, '198.51.100.3');
    expect((await enroll(pilot, p)).status).toBe(201);
    expect((await add({ account_no: a, proxy_id: unmeasured })).status).toBe(201);
    expect((await add({ account_no: b, proxy_id: other })).status).toBe(201);
    expect((await add({ account_no: c, proxy_id: other })).status).toBe(201);
    expect((await change(c, target, other)).status).toBe(200);
    expect((await change(a, other, unmeasured)).status).toBe(200);
  });

  it('refuses nothing while no pilot exists, nor for an engine given outside one', async () => {
    const [outside, plain, moving] = [await account(1), await account(2), await account(3)];
    const [p, q, r] = [await proxy(10001), await proxy(10002), await proxy(10003)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.1');
    await measure(r, '198.51.100.1');
    // All three ports on one IP: a plain add has never minded that.
    expect((await add({ account_no: moving, proxy_id: q })).status).toBe(201);
    expect((await change(moving, r, q)).status).toBe(200);
    expect((await add({ account_no: plain, proxy_id: q })).status).toBe(201);
    await parkAndRemove(plain);
    await parkAndRemove(moving);
    expect((await add({ account_no: outside, proxy_id: p, engine: 'stock' })).status).toBe(201);
    expect((await enrollment(outside)).pilot_id).toBeNull();
    expect((await add({ account_no: plain, proxy_id: q })).status).toBe(201);
  });

  it('frees the exit once the pilot account has no slot', async () => {
    const [pilot, plain] = [await account(1), await account(2)];
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.1');
    expect((await enroll(pilot, p)).status).toBe(201);
    expect((await add({ account_no: plain, proxy_id: q })).body.error).toBe('exit_shared');
    await parkAndRemove(pilot);
    expect((await add({ account_no: plain, proxy_id: q })).status).toBe(201);
  });
});

describe('cloak_max_slots', () => {
  it('refuses enrollment past it, counting parked slots', async () => {
    const [a, b] = [await account(1), await account(2)];
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.2');
    await setSettings({ cloak_max_slots: 1 });
    expect((await enroll(a, p)).status).toBe(201);
    expect((await api('POST', `/api/fleet/slots/${a}/park`, { token })).status).toBe(200);
    const full = await enroll(b, q);
    expect(full.status).toBe(409);
    expect(full.body.error).toBe('cloak_slots_full');
    expect(full.body.detail).toContain('1 of 1');
    // A stock arm spends no seat.
    expect((await enroll(b, q, 'stock')).status).toBe(201);
  });
});

describe('proxy edits and a pinned profile', () => {
  it('leaves an enrolled clock alone and still moves one with no profile', async () => {
    const [pinned, stockArm, plain] = [await account(1), await account(2), await account(3)];
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.2');
    await setSettings({ max_accounts_per_proxy: 3 });
    expect((await enroll(pinned, p)).status).toBe(201);
    expect((await enroll(stockArm, q, 'stock')).status).toBe(201);
    const third = await proxy(10004);
    await measure(third, '198.51.100.4');
    expect((await add({ account_no: plain, proxy_id: third })).status).toBe(201);
    for (const id of [p, q, third]) {
      expect((await api('PUT', `/api/fleet/proxies/${id}`, { token, body: { timezone: 'America/Chicago' } })).status).toBe(200);
    }
    const zone = async (no: number) =>
      (await getTestDb()<{ tz: string }[]>`SELECT device->>'timezone' AS tz FROM fleet_slots WHERE account_no = ${no}`)[0].tz;
    expect(await zone(pinned)).toBe('America/New_York');
    expect(await zone(stockArm)).toBe('America/New_York');
    expect(await zone(plain)).toBe('America/Chicago');
    expect((await profile(pinned)).profile_timezone).toBe('America/New_York');
    // Nor does moving the account to another proxy touch it.
    const [r] = [await proxy(10003, 'America/Denver')];
    await measure(r, '198.51.100.3');
    const moved = await api<Err>('POST', `/api/fleet/slots/${pinned}/proxy`, { token, body: { proxy_id: r, from_proxy_id: p, confirm: true } });
    expect(moved.status).toBe(200);
    expect(await zone(pinned)).toBe('America/New_York');
  });

  it('pins a slot the engine switch seeded', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    expect((await add({ account_no: no, proxy_id: p })).status).toBe(201);
    expect((await api('POST', `/api/fleet/slots/${no}/engine`, { token, body: { engine: 'cloak' } })).status).toBe(200);
    expect((await api('PUT', `/api/fleet/proxies/${p}`, { token, body: { timezone: 'America/Chicago' } })).status).toBe(200);
    const [{ tz }] = await getTestDb()<{ tz: string }[]>`SELECT device->>'timezone' AS tz FROM fleet_slots WHERE account_no = ${no}`;
    expect(tz).toBe('America/New_York');
  });
});

describe('the claim answer', () => {
  it('stamps first_claimed_at once, and only at a claim', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await measure(p, '198.51.100.1');
    expect((await enroll(no, p)).status).toBe(201);
    expect((await enrollment(no)).first_claimed_at).toBeNull();
    expect((await claim('lab-1')).status).toBe(200);
    const first = (await enrollment(no)).first_claimed_at;
    expect(first).toBeInstanceOf(Date);
    const db = getTestDb();
    await db`UPDATE fleet_slots SET lease_expires_at = NOW() - interval '1 minute' WHERE account_no = ${no}`;
    await db`UPDATE fleet_pilot_enrollments SET first_claimed_at = NOW() - interval '1 hour' WHERE account_no = ${no}`;
    const stamped = (await enrollment(no)).first_claimed_at;
    expect((await claim('lab-2')).status).toBe(200);
    expect((await enrollment(no)).first_claimed_at).toEqual(stamped);
  });

  it('gives a cloak slot its measured exit, and nulls instead of a refusal without a fresh one', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await measure(p, '198.51.100.1');
    expect((await enroll(no, p)).status).toBe(201);
    const fresh = await claim('lab-1');
    expect(fresh.body).toMatchObject({ expected_exit_ip: '198.51.100.1', webrtc_ip: '198.51.100.1' });
    const db = getTestDb();
    const again = async () => {
      await db`UPDATE fleet_slots SET lease_expires_at = NOW() - interval '1 minute', worker_id = NULL, host_id = NULL WHERE account_no = ${no}`;
      await db`DELETE FROM fleet_workers`;
      return claim('lab-1');
    };
    // The exit moved: the claim says what was measured last, not what was enrolled.
    await measure(p, '198.51.100.8');
    expect((await again()).body).toMatchObject({ expected_exit_ip: '198.51.100.8', webrtc_ip: '198.51.100.8' });
    await measure(p, null, { ok: false });
    let r = await again();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ expected_exit_ip: null, webrtc_ip: null });
    await db`DELETE FROM fleet_proxy_checks WHERE proxy_id = ${p}`;
    await measure(p, '198.51.100.8', { agoMs: FLEET_EXIT_FRESH_MS + 5_000 });
    r = await again();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ expected_exit_ip: null, webrtc_ip: null });
    // A proxy no longer on the list is not a refusal either.
    await db`UPDATE fleet_slots SET proxy_id = NULL WHERE account_no = ${no}`;
    r = await again();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ expected_exit_ip: null, webrtc_ip: null });
  });

  it('leaves both fields off a stock arm', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await measure(p, '198.51.100.1');
    expect((await enroll(no, p, 'stock')).status).toBe(201);
    const r = await claim('lab-1');
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('expected_exit_ip');
    expect(r.body).not.toHaveProperty('webrtc_ip');
  });
});

describe('with cloak_enabled off', () => {
  // The licence is added at the edge, so this is the path a worker really sees:
  // the backend's answer goes through the Cloudflare Worker's own code.
  const worker = (workerModule as { fetch?: unknown; default?: unknown }).fetch
    ? workerModule as unknown as { fetch: (r: Request, e: unknown) => Promise<Response> }
    : (workerModule as unknown as { default: { fetch: (r: Request, e: unknown) => Promise<Response> } }).default;

  async function throughTheEdge(body: unknown): Promise<{ env?: Record<string, string> }> {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    try {
      const res = await worker.fetch(new Request('https://inventory-dev.example/api/fleet/worker/claim', {
        method: 'POST', headers: { Authorization: 'Bearer host', 'Content-Type': 'application/json' }, body: '{}',
      }), { BACKEND_URL: 'https://backend.example', CLOAKBROWSER_LICENSE_KEY: LICENCE });
      return await res.json() as { env?: Record<string, string> };
    } finally {
      globalThis.fetch = real;
    }
  }

  it('an existing cloak account still claims and still gets the licence; only new enrollment stops', async () => {
    const [survivor, fresh, stock] = [await account(1), await account(2), await account(3)];
    const [p, q, r] = [await proxy(10001), await proxy(10002), await proxy(10003)];
    await measure(p, '198.51.100.1');
    await measure(q, '198.51.100.2');
    await measure(r, '198.51.100.3');
    expect((await enroll(survivor, p)).status).toBe(201);
    const first = await claim('lab-1');
    expect(first.status).toBe(200);

    await setSettings({ cloak_enabled: false });

    // Its worker restarts: same account, same fingerprint.
    const db = getTestDb();
    await db`UPDATE fleet_slots SET lease_expires_at = NOW() - interval '1 minute' WHERE account_no = ${survivor}`;
    const again = await claim('lab-1');
    expect(again.status).toBe(200);
    expect(again.body.account.no).toBe(survivor);
    expect(again.body.device).toMatchObject({ browser_engine: 'cloak', ...fleetCloakFor(survivor) });
    expect(again.body.expected_exit_ip).toBe('198.51.100.1');
    expect((await throughTheEdge(again.body)).env).toEqual({ CLOAKBROWSER_LICENSE_KEY: LICENCE });

    // Only new enrollment stops, and only for CloakBrowser.
    const refused = await enroll(fresh, q);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('cloak_disabled');
    const switched = await add({ account_no: fresh, proxy_id: q });
    expect(switched.status).toBe(201);
    expect((await api<Err>('POST', `/api/fleet/slots/${fresh}/engine`, { token, body: { engine: 'cloak' } })).body.error).toBe('cloak_disabled');
    expect((await enroll(stock, r, 'stock')).status).toBe(201);

    // A stock claim stays without the licence.
    const other = await claim('lab-2');
    expect(other.status).toBe(200);
    expect(other.body.device.browser_engine).not.toBe('cloak');
    expect((await throughTheEdge(other.body)).env).toBeUndefined();

    // The licence went nowhere near the database.
    const dump = await db`SELECT to_jsonb(e) AS row FROM fleet_pilot_enrollments e`;
    const slots = await db`SELECT device FROM fleet_slots`;
    expect(JSON.stringify([dump, slots])).not.toContain(LICENCE);
  });
});

describe('the zone comes from the exit', () => {
  it('sets an enrolled clock from the measurement, not the typed zone, on both arms', async () => {
    const [a, b] = [await account(1), await account(2)];
    const [p, q] = [await proxy(10001, 'America/Chicago'), await proxy(10002, 'America/Chicago')];
    await measure(p, '198.51.100.1', { zone: 'America/Denver' });
    await measure(q, '198.51.100.2', { zone: 'America/Denver' });
    expect((await enroll(a, p, 'cloak')).body.slot.device?.timezone).toBe('America/Denver');
    expect((await enroll(b, q, 'stock')).body.slot.device?.timezone).toBe('America/Denver');
    expect((await profile(a)).profile_timezone).toBe('America/Denver');
    expect((await profile(b)).profile_timezone).toBe('America/Denver');
  });

  it('refuses when the fresh measurement names no usable zone, leaving nothing behind', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await measure(p, '198.51.100.1', { zone: null });
    const none = await enroll(no, p);
    expect(none.status).toBe(409);
    expect(none.body.error).toBe('exit_zone_unknown');
    await measure(p, '198.51.100.1', { zone: 'not a zone' });
    expect((await enroll(no, p)).body.error).toBe('exit_zone_unknown');
    expect(await enrollment(no)).toBeUndefined();
    expect((await profile(no)).browser_engine).toBeNull();
    await measure(p, '198.51.100.1', { zone: 'America/Denver' });
    expect((await enroll(no, p)).status).toBe(201);
  });

  it('keeps a pinned clock, even when the exit names no zone', async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await getTestDb()`UPDATE fb_pool_accounts SET browser_engine = 'stock', profile_timezone = 'Asia/Tokyo' WHERE no = ${no}`;
    await measure(p, '198.51.100.1', { zone: null });
    const res = await enroll(no, p, 'stock');
    expect(res.status).toBe(201);
    expect(res.body.slot.device?.timezone).toBe('Asia/Tokyo');
    expect((await profile(no)).profile_timezone).toBe('Asia/Tokyo');
  });

  it('leaves a plain add on the typed zone, measured or not', async () => {
    const [a, b] = [await account(1), await account(2)];
    const [p, q] = [await proxy(10001, 'America/Chicago'), await proxy(10002, 'America/Chicago')];
    await measure(p, '198.51.100.1', { zone: 'America/Denver' });
    expect((await add({ account_no: a, proxy_id: p })).body.slot.device?.timezone).toBe('America/Chicago');
    expect((await add({ account_no: b, proxy_id: q })).body.slot.device?.timezone).toBe('America/Chicago');
    expect((await profile(a)).browser_engine).toBeNull();
  });
});

describe('a first login on a changed exit', () => {
  const OLD = '198.51.100.1';
  const NEW = '198.51.100.9';
  const setup = async () => {
    const no = await account(1);
    const p = await proxy(10001);
    await measure(p, OLD);
    expect((await enroll(no, p)).status).toBe(201);
    return { no, p };
  };
  const remove = (no: number) => api('POST', `/api/fleet/slots/${no}/remove`, { token });
  const heldOn = async (p: number) => (await api<FleetProxyHealthAnswer>('GET', '/api/fleet/proxies/health', { token }))
    .body.proxies.find((r) => r.proxy_id === p)!.slots.map((s) => s.held_exit_ip);

  it('gives the worker no_slot while the latest good exit differs, then only the free account', async () => {
    const { no, p } = await setup();
    await measure(p, NEW);
    const refused = await claim('lab-1');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('no_slot');
    expect((await enrollment(no)).first_claimed_at).toBeNull();
    expect((await getTestDb()`SELECT 1 FROM fb_worker_accounts WHERE account_no = ${no} AND worker_id = 'lab-1'`)).toHaveLength(0);
    expect(await heldOn(p)).toEqual([OLD]);

    const other = await account(2);
    const q = await proxy(10002);
    await add({ account_no: other, proxy_id: q });
    const got = await claim('lab-1');
    expect(got.status).toBe(200);
    expect(got.body.account.no).toBe(other);
  });

  it('goes by the latest good measurement: a failed check neither holds nor releases', async () => {
    const { p } = await setup();
    await measure(p, null, { ok: false });
    expect(await heldOn(p)).toEqual([null]);
    expect((await claim('lab-1')).status).toBe(200);
  });

  it('holds through a failure after the move, and on an unmeasured port does not', async () => {
    const { no, p } = await setup();
    await measure(p, NEW);
    await measure(p, null, { ok: false });
    expect((await claim('lab-1')).status).toBe(409);
    await getTestDb()`DELETE FROM fleet_proxy_checks WHERE proxy_id = ${p}`;
    const got = await claim('lab-1');
    expect(got.status).toBe(200);
    expect(got.body.account.no).toBe(no);
  });

  it('releases when a re-add records the fresh exit', async () => {
    const { no, p } = await setup();
    await measure(p, NEW);
    expect((await remove(no)).status).toBe(200);
    expect((await add({ account_no: no, proxy_id: p })).status).toBe(201);
    expect((await enrollment(no)).exit_ip).toBe(NEW);
    expect(await heldOn(p)).toEqual([null]);
    expect((await claim('lab-1')).status).toBe(200);
  });

  it('releases when Change proxy records the fresh exit', async () => {
    const { no, p } = await setup();
    await measure(p, NEW);
    const q = await proxy(10002);
    await measure(q, '198.51.100.20');
    const res = await api('POST', `/api/fleet/slots/${no}/proxy`, { token, body: { proxy_id: q, from_proxy_id: p, confirm: true } });
    expect(res.status).toBe(200);
    expect((await enrollment(no)).exit_ip).toBe('198.51.100.20');
    expect((await claim('lab-1')).status).toBe(200);
  });

  it('never touches an account once claimed: still claimable, and its record stays', async () => {
    const { no, p } = await setup();
    expect((await claim('lab-1')).status).toBe(200);
    const first = (await enrollment(no)).first_claimed_at;
    await getTestDb()`UPDATE fleet_slots SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE account_no = ${no}`;
    await measure(p, NEW);
    expect(await heldOn(p)).toEqual([null]);
    const again = await claim('lab-2');
    expect(again.status).toBe(200);
    expect(again.body.account.no).toBe(no);

    await getTestDb()`UPDATE fleet_slots SET lease_expires_at = NULL, worker_id = NULL WHERE account_no = ${no}`;
    expect((await remove(no)).status).toBe(200);
    expect((await add({ account_no: no, proxy_id: p })).status).toBe(201);
    expect(await enrollment(no)).toMatchObject({ exit_ip: OLD, first_claimed_at: first });
    const q = await proxy(10002);
    await measure(q, '198.51.100.20');
    expect((await api('POST', `/api/fleet/slots/${no}/proxy`, { token, body: { proxy_id: q, from_proxy_id: p, confirm: true } })).status).toBe(200);
    expect((await enrollment(no)).exit_ip).toBe(OLD);
  });

  it('never holds a slot outside a pilot: a plain add, or an engine given alone', async () => {
    const [a, b] = [await account(1), await account(2)];
    const [p, q] = [await proxy(10001), await proxy(10002)];
    await measure(p, OLD);
    await measure(q, '198.51.100.2');
    await add({ account_no: a, proxy_id: p });
    expect((await add({ account_no: b, proxy_id: q, engine: 'stock' })).status).toBe(201);
    await measure(p, NEW);
    await measure(q, '198.51.100.30');
    expect(await heldOn(q)).toEqual([null]);
    const claimed = [(await claim('lab-1')).body.account.no, (await claim('lab-2')).body.account.no];
    expect(claimed.sort()).toEqual([a, b].sort());
  });

  it('with no pilot, picks the same slots in the same order as before', async () => {
    const nos = [await account(1), await account(2), await account(3)];
    const p = await proxy(10001);
    await setSettings({ max_accounts_per_proxy: 10 });
    await measure(p, OLD);
    for (const no of nos) expect((await add({ account_no: no, proxy_id: p })).status).toBe(201);
    await measure(p, NEW);
    expect([(await claim('lab-1')).body.account.no, (await claim('lab-2')).body.account.no, (await claim('lab-3')).body.account.no]).toEqual(nos);
    expect((await claim('lab-4')).body.error).toBe('no_slot');
  });
});

describe('the migration, on rows that exist already', () => {
  it('copies seeded slots to the pool row, tolerates a duplicate seed and leaves stock slots unpinned', async () => {
    const dir = join(import.meta.dirname, '..', 'migrations');
    const file = readdirSync(dir).find((f) => f.endsWith('_fleet_pilot_enrollment.sql'))!;
    const migration = readFileSync(join(dir, file), 'utf8');
    const [cloak, reverted, twin, stock, bare] = [await account(1), await account(2), await account(3), await account(4), await account(5)];
    const db = getTestDb();
    class Rollback extends Error {}
    await expect(db.begin(async (tx) => {
      await tx.unsafe(`
        DROP TABLE fleet_pilot_enrollments;
        ALTER TABLE fb_pool_accounts DROP CONSTRAINT fb_pool_accounts_cloak_has_seed;
        DROP INDEX fb_pool_accounts_cloak_seed_key;
        ALTER TABLE fb_pool_accounts DROP COLUMN browser_engine, DROP COLUMN cloak_seed, DROP COLUMN cloak_gpu, DROP COLUMN profile_timezone;`);
      const slot = (no: number, device: unknown) => tx`INSERT INTO fleet_slots (account_no, device) VALUES (${no}, ${device === null ? null : tx.json(device as never)})`;
      await slot(cloak, { timezone: 'America/Chicago', browser_engine: 'cloak', cloak_seed: 11111, cloak_gpu: 'Intel' });
      await slot(reverted, { timezone: 'America/Denver', browser_engine: 'stock', cloak_seed: 22222, cloak_gpu: 'NVIDIA' });
      await slot(twin, { timezone: 'UTC', browser_engine: 'cloak', cloak_seed: 11111, cloak_gpu: 'Intel' });
      await slot(stock, { timezone: 'America/New_York' });
      await slot(bare, null);

      await tx.unsafe(migration);

      const rows = await tx`SELECT no, browser_engine, cloak_seed, cloak_gpu, profile_timezone FROM fb_pool_accounts WHERE no = ANY(${[cloak, reverted, twin, stock, bare]}::int[]) ORDER BY no`;
      expect(rows).toEqual([
        { no: cloak, browser_engine: 'cloak', cloak_seed: 11111, cloak_gpu: 'Intel', profile_timezone: 'America/Chicago' },
        { no: reverted, browser_engine: 'stock', cloak_seed: 22222, cloak_gpu: 'NVIDIA', profile_timezone: 'America/Denver' },
        { no: twin, browser_engine: null, cloak_seed: null, cloak_gpu: null, profile_timezone: null },
        { no: stock, browser_engine: null, cloak_seed: null, cloak_gpu: null, profile_timezone: null },
        { no: bare, browser_engine: null, cloak_seed: null, cloak_gpu: null, profile_timezone: null },
      ]);
      expect(await tx`SELECT 1 FROM fleet_pilot_enrollments`).toHaveLength(0);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
  });
});
