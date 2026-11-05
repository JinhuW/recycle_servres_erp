import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  fleetCloakFor, fleetCloakSwitchable, fleetStockRevertible, fleetVersionAtLeast, FLEET_CLOAK_GPUS, FLEET_CLOAK_MIN_WORKER_VERSION,
  type ClaimAnswer, type FleetSettings, type FleetSlot,
} from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { sha256hex } from '../src/fleet/sql';
import { poolKey, seal } from '../src/lib/sealed';

// The per-slot browser engine switch and the two settings that gate it.
// Every account, host, token and proxy here is made up.

const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const DEVICE = { viewport: [1366, 645], screen: [1366, 768], device_scale_factor: 1, timezone: 'America/Chicago', locale: 'en-US', native: ['user_agent'] };

/** `session: false` is a pool account with no saved session, one never logged in. */
async function seedSlot(n: number, device: Record<string, unknown> | null = DEVICE, { session = true } = {}): Promise<number> {
  const db = getTestDb();
  const k = poolKey(testEnv)!;
  const uid = `6155000000000${n}`;
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, totp_enc, cookie_enc, cookie_uid)
    VALUES (${uid}, 'fixtures', 'fleet', 'ERP fleet', ${seal(`pw-${n}`, k)}, ${seal(`abcd efgh-${n}`, k)},
            ${session ? seal(`c_user=${uid}; xs=xs-${n}`, k) : null}, ${uid})
    RETURNING no`;
  await db`
    INSERT INTO fleet_slots (account_no, proxy_url, device)
    VALUES (${a.no}, ${seal(`http://u:p@exit-${n}.example:10000`, k)}, ${device === null ? null : db.json(device as never)})`;
  return a.no;
}

const tryClaim = (workerId: string, version = FLEET_CLOAK_MIN_WORKER_VERSION) =>
  api<ClaimAnswer & { error?: string }>('POST', '/api/fleet/worker/claim', {
    headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id: workerId, version, vnc_port: 5901 },
  });

async function claim(workerId: string, version?: string): Promise<ClaimAnswer> {
  const r = await tryClaim(workerId, version);
  expect(r.status).toBe(200);
  return r.body;
}

const heartbeat = (token: string, state: string, detail: Record<string, unknown> | null = null) =>
  api('POST', '/api/fleet/worker/heartbeat', { headers: bearer(token), body: { state, version: FLEET_CLOAK_MIN_WORKER_VERSION, detail } });

const park = async (manager: string, no: number) =>
  expect((await api('POST', `/api/fleet/slots/${no}/park`, { token: manager, body: {} })).status).toBe(200);

const setSettings = async (manager: string, body: Partial<FleetSettings>) =>
  expect((await api('PUT', '/api/fleet/settings', { token: manager, body })).status).toBe(200);

const switchTo = (manager: string, no: number, engine: unknown) =>
  api<{ slot: FleetSlot; error?: string }>('POST', `/api/fleet/slots/${no}/engine`, { token: manager, body: { engine } });

const deviceOf = async (no: number) =>
  (await getTestDb()<{ device: Record<string, unknown> | null }[]>`SELECT device FROM fleet_slots WHERE account_no = ${no}`)[0].device;

describe('fleetCloakFor', () => {
  it('gives an account the same seed and GPU every time, in range', () => {
    expect(fleetCloakFor(42)).toEqual(fleetCloakFor(42));
    const all = Array.from({ length: 200 }, (_, i) => fleetCloakFor(i + 1));
    for (const c of all) {
      expect(Number.isInteger(c.cloak_seed)).toBe(true);
      expect(c.cloak_seed).toBeGreaterThanOrEqual(10000);
      expect(c.cloak_seed).toBeLessThanOrEqual(99999);
      expect(FLEET_CLOAK_GPUS).toContain(c.cloak_gpu);
    }
    expect(new Set(all.map((c) => c.cloak_gpu)).size).toBe(2);
    expect(new Set(all.map((c) => c.cloak_seed)).size).toBeGreaterThan(190);
  });

  it('gives different accounts different fingerprints', () => {
    expect(fleetCloakFor(1)).not.toEqual(fleetCloakFor(2));
  });
});

describe('fleetCloakSwitchable', () => {
  const base = { epoch: 3, account_state: 'HEALTHY', has_session: true, fleet_held: true, device: null };
  it('allows only an account that lost its session, or one no fleet worker has held', () => {
    expect(fleetCloakSwitchable(base)).toBe(false);
    for (const account_state of [null, 'DEGRADED', 'DEAD']) expect(fleetCloakSwitchable({ ...base, account_state })).toBe(false);
    for (const account_state of ['SESSION_EXPIRED', 'CHECKPOINT', 'CHALLENGE', 'CHALLENGE_2FA']) {
      expect(fleetCloakSwitchable({ ...base, account_state })).toBe(true);
    }
    const fresh = { epoch: 0, account_state: null, has_session: false, fleet_held: false, device: null };
    expect(fleetCloakSwitchable(fresh)).toBe(true);
    // The seller's cookie on an account no fleet worker held carries no fleet fingerprint.
    expect(fleetCloakSwitchable({ ...fresh, has_session: true })).toBe(true);
    expect(fleetCloakSwitchable({ ...fresh, has_session: true, fleet_held: true })).toBe(false);
    expect(fleetCloakSwitchable({ ...fresh, epoch: 1 })).toBe(false);
    expect(fleetCloakSwitchable({ ...fresh, device: { ...DEVICE, cloak_seed: 12345 } as never })).toBe(false);
  });
});

describe('fleetStockRevertible', () => {
  it('needs no worker that could be running, or a lost session', () => {
    expect(fleetStockRevertible({ parked: false, worker_id: 'lab-1', account_state: null })).toBe(false);
    expect(fleetStockRevertible({ parked: false, worker_id: 'lab-1', account_state: 'HEALTHY' })).toBe(false);
    expect(fleetStockRevertible({ parked: false, worker_id: 'lab-1', account_state: 'CHECKPOINT' })).toBe(true);
    expect(fleetStockRevertible({ parked: true, worker_id: null, account_state: 'HEALTHY' })).toBe(true);
    expect(fleetStockRevertible({ parked: false, worker_id: null, account_state: null })).toBe(true);
  });
});

describe('fleetVersionAtLeast', () => {
  it('compares dotted numbers and refuses what does not parse', () => {
    expect(fleetVersionAtLeast('0.16.0', '0.16.0')).toBe(true);
    expect(fleetVersionAtLeast('0.16.2', '0.16.0')).toBe(true);
    expect(fleetVersionAtLeast('1.0.0', '0.16.0')).toBe(true);
    expect(fleetVersionAtLeast('0.15.9', '0.16.0')).toBe(false);
    expect(fleetVersionAtLeast('0.9.0', '0.16.0')).toBe(false);
    expect(fleetVersionAtLeast('unknown', '0.16.0')).toBe(false);
    expect(fleetVersionAtLeast(null, '0.16.0')).toBe(false);
  });
});

describe('cloak settings', () => {
  let manager: string;
  beforeEach(async () => { await resetDb(); ({ token: manager } = await loginAs(ALEX)); });

  it('default to off and one slot, and save', async () => {
    const r = await api<FleetSettings>('GET', '/api/fleet/settings', { token: manager });
    expect(r.body).toMatchObject({ cloak_enabled: false, cloak_max_slots: 1 });
    const saved = await api<FleetSettings>('PUT', '/api/fleet/settings', { token: manager, body: { cloak_enabled: true, cloak_max_slots: 3 } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ cloak_enabled: true, cloak_max_slots: 3 });
    const again = await api<FleetSettings>('GET', '/api/fleet/settings', { token: manager });
    expect(again.body).toMatchObject({ cloak_enabled: true, cloak_max_slots: 3, budget_minutes: 360 });
  });

  it('refuses a flag that is not a boolean and a limit out of bounds', async () => {
    const put = (body: unknown) => api('PUT', '/api/fleet/settings', { token: manager, body: body as Record<string, unknown> });
    expect((await put({ cloak_enabled: 'yes' })).status).toBe(422);
    expect((await put({ cloak_enabled: 1 })).status).toBe(422);
    expect((await put({ cloak_max_slots: -1 })).status).toBe(422);
    expect((await put({ cloak_max_slots: 101 })).status).toBe(422);
    expect((await put({ cloak_max_slots: 1.5 })).status).toBe(422);
  });
});

describe('POST /api/fleet/slots/:no/engine', () => {
  let manager: string;
  beforeEach(async () => {
    await resetDb();
    await getTestDb()`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 2, TRUE)`;
    ({ token: manager } = await loginAs(ALEX));
  });

  it('refuses while cloak_enabled is off', async () => {
    const no = await seedSlot(1, DEVICE, { session: false });
    const r = await switchTo(manager, no, 'cloak');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cloak_disabled');
    expect(await deviceOf(no)).toEqual(DEVICE);
  });

  it('switches an account never logged in, merging the seed into the device', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, DEVICE, { session: false });
    const r = await switchTo(manager, no, 'cloak');
    expect(r.status).toBe(200);
    const want = { ...DEVICE, browser_engine: 'cloak', ...fleetCloakFor(no) };
    expect(await deviceOf(no)).toEqual(want);
    expect(r.body.slot.device).toEqual(want);
  });

  it('gives a slot with no stored device just the engine keys', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, null, { session: false });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    expect(await deviceOf(no)).toEqual({ browser_engine: 'cloak', ...fleetCloakFor(no) });
  });

  it('refuses past cloak_max_slots, and takes one more when it is raised', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const a = await seedSlot(1, DEVICE, { session: false });
    const b = await seedSlot(2, DEVICE, { session: false });
    expect((await switchTo(manager, a, 'cloak')).status).toBe(200);
    const r = await switchTo(manager, b, 'cloak');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cloak_slots_full');
    await setSettings(manager, { cloak_max_slots: 2 });
    expect((await switchTo(manager, b, 'cloak')).status).toBe(200);
  });

  it('refuses a worker that is HEALTHY, booting or DEAD, and allows one that lost its session', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1);
    const { worker_token } = await claim('lab-1');
    let r = await switchTo(manager, no, 'cloak');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('engine_live_session');
    for (const state of ['HEALTHY', 'DEAD']) {
      await heartbeat(worker_token, state);
      r = await switchTo(manager, no, 'cloak');
      expect(r.body.error).toBe('engine_live_session');
    }
    await heartbeat(worker_token, 'CHECKPOINT');
    r = await switchTo(manager, no, 'cloak');
    expect(r.status).toBe(200);
    expect((await deviceOf(no))!.browser_engine).toBe('cloak');
  });

  it('refuses a slot no worker holds whose account a fleet worker saved a session for', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1);
    await getTestDb()`INSERT INTO fb_pool_events (account_no, actor_id, actor_name, kind, status, detail)
                      VALUES (${no}, NULL, 'fleet host lab', 'assigned', 'fleet', 'lab-1')`;
    const r = await switchTo(manager, no, 'cloak');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('engine_live_session');
    const stint = await seedSlot(2);
    await getTestDb()`INSERT INTO fb_worker_accounts (worker_id, account_no, uid, started_at, ended_at, outcome) VALUES ('homelab-3', ${stint}, 'uid-2', NOW() - interval '9 days', NOW() - interval '8 days', 'fleet')`;
    expect((await switchTo(manager, stint, 'cloak')).body.error).toBe('engine_live_session');
  });

  it('switches an account no fleet worker held even with the seller\'s cookie, and says so on the slot', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1);
    const r = await switchTo(manager, no, 'cloak');
    expect(r.status).toBe(200);
    expect(r.body.slot).toMatchObject({ has_session: true, fleet_held: false });
    expect(await deviceOf(no)).toMatchObject({ browser_engine: 'cloak', ...fleetCloakFor(no) });
  });

  it('refuses a parked slot whose account was HEALTHY or still booting', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const healthy = await seedSlot(1);
    const { worker_token } = await claim('lab-1');
    await heartbeat(worker_token, 'HEALTHY');
    await park(manager, healthy);
    let r = await switchTo(manager, healthy, 'cloak');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('engine_live_session');
    expect(r.body.slot).toBeUndefined();

    const booting = await seedSlot(2, DEVICE, { session: false });
    await claim('lab-2');
    await park(manager, booting);
    r = await switchTo(manager, booting, 'cloak');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('engine_live_session');
  });

  it('allows a parked slot whose account went CHECKPOINT, and shows that on the slot', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1);
    const { worker_token } = await claim('lab-1');
    await heartbeat(worker_token, 'HEALTHY');
    await heartbeat(worker_token, 'CHECKPOINT');
    await park(manager, no);
    const list = await api<{ slots: FleetSlot[] }>('GET', '/api/fleet/slots', { token: manager });
    expect(list.body.slots.find((s) => s.account_no === no)).toMatchObject({ parked: true, account_state: 'CHECKPOINT', has_session: true });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
  });

  it('reads the account\'s own state, not that of another account its old worker moved to', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const db = getTestDb();
    const first = await seedSlot(1);
    const second = await seedSlot(2);
    const { worker_token } = await claim('lab-1');
    await heartbeat(worker_token, 'HEALTHY');
    // The first lease lapses with the slot still naming lab-1, and lab-1 then
    // holds the second account, which goes CHECKPOINT: the claim's upsert and
    // the heartbeat's event, as they land.
    await db`UPDATE fleet_slots SET lease_expires_at = NOW() - interval '1 minute' WHERE account_no = ${first}`;
    await db`UPDATE fleet_slots SET worker_id = 'lab-1', epoch = 1, lease_expires_at = NOW() + interval '10 minutes' WHERE account_no = ${second}`;
    await db`UPDATE fleet_workers SET account_no = ${second}, epoch = 1, state = 'CHECKPOINT' WHERE worker_id = 'lab-1'`;
    await db`INSERT INTO fleet_worker_state_events (account_no, worker_id, engine, from_state, to_state) VALUES (${second}, 'lab-1', 'stock', NULL, 'CHECKPOINT')`;
    const r = await switchTo(manager, first, 'cloak');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('engine_live_session');
    expect((await switchTo(manager, second, 'cloak')).status).toBe(200);
  });

  it('hands the cloak keys to the next claim', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, DEVICE, { session: false });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    const a = await claim('lab-1');
    expect(a.device).toMatchObject({ browser_engine: 'cloak', ...fleetCloakFor(no), viewport: DEVICE.viewport });
  });

  it('keeps a slot leased through a licence outage, so a worker with no slot takes stock first', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const cloak = await seedSlot(1, DEVICE, { session: false });
    expect((await switchTo(manager, cloak, 'cloak')).status).toBe(200);
    const got = await claim('lab-1');
    expect(got.account.no).toBe(cloak);
    const stock = await seedSlot(2);
    expect((await heartbeat(got.worker_token, 'DEAD', { reason: 'license_outage', operator: true, exit_code: 78 })).status).toBe(200);
    const [{ hours }] = await getTestDb()<{ hours: number }[]>`
      SELECT EXTRACT(EPOCH FROM lease_expires_at - NOW()) / 3600 AS hours FROM fleet_slots WHERE account_no = ${cloak}`;
    expect(Number(hours)).toBeGreaterThan(23);
    expect((await claim('lab-2')).account.no).toBe(stock);
    // Other reasons keep the ordinary lease.
    expect((await tryClaim('lab-3')).status).toBe(409);
    await heartbeat(got.worker_token, 'DEAD', { reason: 'connect_failed', operator: true });
    const [{ ordinary }] = await getTestDb()<{ ordinary: number }[]>`
      SELECT EXTRACT(EPOCH FROM lease_expires_at - NOW()) / 3600 AS ordinary FROM fleet_slots WHERE account_no = ${cloak}`;
    expect(Number(ordinary)).toBeLessThan(2);
    // A host lost mid-outage needn't strand its account for the whole lease.
    await heartbeat(got.worker_token, 'DEAD', { reason: 'license_outage', operator: true, exit_code: 78 });
    expect((await api('POST', `/api/fleet/slots/${cloak}/park`, { token: manager })).status).toBe(200);
    expect((await api('POST', `/api/fleet/slots/${cloak}/remove`, { token: manager })).status).toBe(200);
  });

  it('alerts managers of an outage once an hour, however many workers report it', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const cloak = await seedSlot(1, DEVICE, { session: false });
    expect((await switchTo(manager, cloak, 'cloak')).status).toBe(200);
    const got = await claim('lab-1');
    const beat = () => heartbeat(got.worker_token, 'DEAD', { reason: 'license_outage', operator: true });
    const sent = async () => (await getTestDb()<{ title: string }[]>`SELECT DISTINCT title FROM notifications WHERE kind = 'fleet_licence_outage'`).length;
    const count = async () => (await getTestDb()`SELECT 1 FROM notifications WHERE kind = 'fleet_licence_outage'`).length;
    await beat();
    const first = await count();
    expect(first).toBeGreaterThan(0);
    expect(await sent()).toBe(1);
    await beat();
    expect(await count()).toBe(first);
  });

  it('takes a manager\'s restart for a moved exit, and never queues one by itself', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const cloak = await seedSlot(1, DEVICE, { session: false });
    expect((await switchTo(manager, cloak, 'cloak')).status).toBe(200);
    const got = await claim('lab-1');
    await heartbeat(got.worker_token, 'DEAD', { reason: 'exit_moved', operator: true, engine: 'cloak' });
    const db = getTestDb();
    await db`UPDATE fleet_workers SET state_since = NOW() - INTERVAL '5 hours' WHERE worker_id = 'lab-1'`;
    await heartbeat(got.worker_token, 'DEAD', { reason: 'exit_moved', operator: true, engine: 'cloak' });
    expect((await db<{ resume_id: string | null }[]>`SELECT resume_id FROM fleet_workers WHERE worker_id = 'lab-1'`)[0].resume_id).toBeNull();
    expect((await api('POST', '/api/fleet/workers/lab-1/resume', { token: manager })).status).toBe(200);
    expect((await db<{ resume_requested_by: string }[]>`SELECT resume_requested_by FROM fleet_workers WHERE worker_id = 'lab-1'`)[0].resume_requested_by).not.toBe('auto');
  });

  it('dismisses one notification without emptying the inbox', async () => {
    const db = getTestDb();
    const [{ id: uid }] = await db<{ id: string }[]>`SELECT id FROM users WHERE email = ${ALEX} LIMIT 1`;
    const made = await db<{ id: string }[]>`INSERT INTO notifications (user_id, kind, tone, icon, title, body)
      VALUES (${uid}, 'fleet_proxy_exit', 'warn', 'alert', 'One', ''), (${uid}, 'fleet_proxy_exit', 'warn', 'alert', 'Two', '') RETURNING id`;
    expect((await api('POST', '/api/notifications/mark-read', { token: manager, body: { id: made[0].id } })).status).toBe(200);
    const unread = await db<{ id: string }[]>`SELECT id FROM notifications WHERE user_id = ${uid} AND unread AND id = ANY(${made.map((m) => m.id)})`;
    expect(unread.map((r) => r.id)).toEqual([made[1].id]);
  });

  it('pins the clock the slot really exits from when it switches', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, DEVICE, { session: false });
    const db = getTestDb();
    const [p] = await db<{ id: number }[]>`INSERT INTO fleet_proxies (label, url_enc, host, port, timezone)
      VALUES ('P', ${seal('http://u:p@exit.example:1', poolKey(testEnv)!)}, 'exit.example', 1, 'America/New_York') RETURNING id`;
    await db`UPDATE fleet_slots SET proxy_id = ${p.id} WHERE account_no = ${no}`;
    await db`INSERT INTO fleet_proxy_checks (exit, source, proxy_id, checked_at, ok, latency_ms, exit_ip, timezone)
      VALUES ('http://exit.example:1', 'erp', ${p.id}, NOW(), TRUE, 1, '198.51.100.3', 'America/Denver')`;
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    expect((await deviceOf(no))!.timezone).toBe('America/Denver');
    expect((await db<{ profile_timezone: string }[]>`SELECT profile_timezone FROM fb_pool_accounts WHERE no = ${no}`)[0].profile_timezone).toBe('America/Denver');
  });

  it('leaves a cloak slot unclaimed by a worker too old to run CloakBrowser', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, DEVICE, { session: false });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    for (const version of ['0.15.0', '0.16.0', 'unknown']) {
      const r = await tryClaim('lab-1', version);
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('no_slot');
    }
    const stock = await seedSlot(2);
    expect((await claim('lab-1', '0.15.0')).account.no).toBe(stock);
    expect((await claim('lab-2')).account.no).toBe(no);
  });

  it('gives a worker new enough for CloakBrowser the free cloak slot before a lower-numbered stock one', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const stock = await seedSlot(1);
    const no = await seedSlot(2, DEVICE, { session: false });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    expect((await claim('lab-1')).account.no).toBe(no);
    expect((await claim('lab-2')).account.no).toBe(stock);
  });

  it('keeps a cloak-capable worker on its own previous stock slot', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const stock = await seedSlot(1);
    await getTestDb()`UPDATE fleet_slots SET worker_id = 'lab-1', host_id = 'lab', last_host_id = 'lab' WHERE account_no = ${stock}`;
    const no = await seedSlot(2, DEVICE, { session: false });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    expect((await claim('lab-1')).account.no).toBe(stock);
  });

  it('refuses Back to stock while a cloak worker is booting on the slot', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, DEVICE, { session: false });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    const { worker_token } = await claim('lab-1');
    let r = await switchTo(manager, no, 'stock');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('engine_live_session');
    await heartbeat(worker_token, 'DEGRADED', { engine: 'cloak' });
    r = await switchTo(manager, no, 'stock');
    expect(r.body.error).toBe('engine_live_session');
    expect((await deviceOf(no))!.browser_engine).toBe('cloak');
    await park(manager, no);
    expect((await switchTo(manager, no, 'stock')).status).toBe(200);
  });

  it('goes back to stock while the cloak session never got HEALTHY, keeping the seed and refusing a second switch', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, DEVICE, { session: false });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    const { worker_token } = await claim('lab-1');
    await heartbeat(worker_token, 'SESSION_EXPIRED');
    const r = await switchTo(manager, no, 'stock');
    expect(r.status).toBe(200);
    expect(await deviceOf(no)).toEqual({ ...DEVICE, browser_engine: 'stock', ...fleetCloakFor(no) });
    const again = await switchTo(manager, no, 'cloak');
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('cloak_seeded');
  });

  it('refuses stock once the cloak session has been HEALTHY', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, DEVICE, { session: false });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    const { worker_token } = await claim('lab-1');
    await heartbeat(worker_token, 'HEALTHY');
    await heartbeat(worker_token, 'CHECKPOINT');
    const r = await switchTo(manager, no, 'stock');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cloak_proven');
    expect((await deviceOf(no))!.browser_engine).toBe('cloak');
  });

  it('refuses Re-login and Mark healthy while the worker runs another engine than its slot\'s', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1);
    const { worker_token } = await claim('lab-1');
    await heartbeat(worker_token, 'CHECKPOINT');
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    for (const verb of ['relogin', 'resume']) {
      const r = await api<{ error?: string }>('POST', `/api/fleet/workers/lab-1/${verb}`, { token: manager, body: {} });
      expect(r.status).toBe(409);
      expect(r.body.error).toBe('engine_mismatch');
    }
    const [w] = await getTestDb()<{ relogin_id: string | null }[]>`SELECT relogin_id FROM fleet_workers WHERE worker_id = 'lab-1'`;
    expect(w.relogin_id).toBeNull();
  });

  it('takes Re-login when the worker reports the slot\'s engine', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, DEVICE, { session: false });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    const { worker_token } = await claim('lab-1');
    await heartbeat(worker_token, 'SESSION_EXPIRED', { engine: 'cloak' });
    expect((await api('POST', '/api/fleet/workers/lab-1/relogin', { token: manager, body: {} })).status).toBe(200);
  });

  it('stamps a state event with the engine the worker reports, else the slot\'s', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, DEVICE, { session: false });
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    const { worker_token } = await claim('lab-1');
    await heartbeat(worker_token, 'DEGRADED');
    await heartbeat(worker_token, 'HEALTHY', { engine: 'stock' });
    await heartbeat(worker_token, 'CHECKPOINT', { engine: 'cloak' });
    await heartbeat(worker_token, 'SESSION_EXPIRED', { engine: 'firefox' });
    const rows = await getTestDb()<{ to_state: string; engine: string }[]>`
      SELECT to_state, engine FROM fleet_worker_state_events WHERE account_no = ${no} ORDER BY id`;
    expect(rows).toEqual([
      { to_state: 'DEGRADED', engine: 'cloak' },
      { to_state: 'HEALTHY', engine: 'stock' },
      { to_state: 'CHECKPOINT', engine: 'cloak' },
      { to_state: 'SESSION_EXPIRED', engine: 'cloak' },
    ]);
    // A HEALTHY that ran on stock does not make the cloak session proven.
    await park(manager, no);
    expect((await switchTo(manager, no, 'stock')).status).toBe(200);
  });

  it('answers the slot unchanged for the engine it already has, even with cloak off', async () => {
    const no = await seedSlot(1);
    const r = await switchTo(manager, no, 'stock');
    expect(r.status).toBe(200);
    expect(await deviceOf(no)).toEqual(DEVICE);
  });

  it('refuses a bad body, an unknown slot and a non-manager', async () => {
    const no = await seedSlot(1);
    expect((await switchTo(manager, no, 'firefox')).status).toBe(422);
    expect((await api('POST', `/api/fleet/slots/${no}/engine`, { token: manager, body: {} })).status).toBe(422);
    expect((await switchTo(manager, 999, 'cloak')).status).toBe(404);
    const { token: purchaser } = await loginAs(MARCUS);
    expect((await switchTo(purchaser, no, 'cloak')).status).toBe(403);
  });
});
