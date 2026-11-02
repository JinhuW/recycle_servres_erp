import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  fleetCloakFor, fleetCloakSwitchable, FLEET_CLOAK_GPUS, type ClaimAnswer, type FleetSettings, type FleetSlot,
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

async function seedSlot(n: number, device: Record<string, unknown> | null = DEVICE): Promise<number> {
  const db = getTestDb();
  const k = poolKey(testEnv)!;
  const uid = `6155000000000${n}`;
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, totp_enc, cookie_enc, cookie_uid)
    VALUES (${uid}, 'fixtures', 'fleet', 'ERP fleet', ${seal(`pw-${n}`, k)}, ${seal(`abcd efgh-${n}`, k)},
            ${seal(`c_user=${uid}; xs=xs-${n}`, k)}, ${uid})
    RETURNING no`;
  await db`
    INSERT INTO fleet_slots (account_no, proxy_url, device)
    VALUES (${a.no}, ${seal(`http://u:p@exit-${n}.example:10000`, k)}, ${device === null ? null : db.json(device as never)})`;
  return a.no;
}

async function claim(workerId: string): Promise<ClaimAnswer> {
  const r = await api<ClaimAnswer>('POST', '/api/fleet/worker/claim', {
    headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id: workerId, version: '0.15.0', vnc_port: 5901 },
  });
  expect(r.status).toBe(200);
  return r.body;
}

const heartbeat = (token: string, state: string) =>
  api('POST', '/api/fleet/worker/heartbeat', { headers: bearer(token), body: { state, version: '0.15.0', detail: null } });

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
  const base = { parked: false, worker_id: 'lab-1', state: 'HEALTHY', device: null };
  it('follows the slot and its worker', () => {
    expect(fleetCloakSwitchable(base)).toBe(false);
    expect(fleetCloakSwitchable({ ...base, state: null })).toBe(false);
    expect(fleetCloakSwitchable({ ...base, state: 'DEGRADED' })).toBe(false);
    expect(fleetCloakSwitchable({ ...base, state: 'DEAD' })).toBe(false);
    for (const state of ['SESSION_EXPIRED', 'CHECKPOINT', 'CHALLENGE', 'CHALLENGE_2FA']) {
      expect(fleetCloakSwitchable({ ...base, state })).toBe(true);
    }
    expect(fleetCloakSwitchable({ ...base, parked: true })).toBe(true);
    expect(fleetCloakSwitchable({ ...base, worker_id: null, state: null })).toBe(true);
    expect(fleetCloakSwitchable({ ...base, worker_id: null, state: null, device: { ...DEVICE, cloak_seed: 12345 } as never })).toBe(false);
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
    const no = await seedSlot(1);
    const r = await switchTo(manager, no, 'cloak');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cloak_disabled');
    expect(await deviceOf(no)).toEqual(DEVICE);
  });

  it('switches a slot no worker holds, merging the seed into the device', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1);
    const r = await switchTo(manager, no, 'cloak');
    expect(r.status).toBe(200);
    const want = { ...DEVICE, browser_engine: 'cloak', ...fleetCloakFor(no) };
    expect(await deviceOf(no)).toEqual(want);
    expect(r.body.slot.device).toEqual(want);
  });

  it('gives a slot with no stored device just the engine keys', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1, null);
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    expect(await deviceOf(no)).toEqual({ browser_engine: 'cloak', ...fleetCloakFor(no) });
  });

  it('refuses past cloak_max_slots, and takes one more when it is raised', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const a = await seedSlot(1);
    const b = await seedSlot(2);
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

  it('allows a parked slot whatever its last worker said', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1);
    const { worker_token } = await claim('lab-1');
    await heartbeat(worker_token, 'HEALTHY');
    expect((await api('POST', `/api/fleet/slots/${no}/park`, { token: manager, body: {} })).status).toBe(200);
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
  });

  it('hands the cloak keys to the next claim', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1);
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    const a = await claim('lab-1');
    expect(a.device).toMatchObject({ browser_engine: 'cloak', ...fleetCloakFor(no), viewport: DEVICE.viewport });
  });

  it('goes back to stock while the cloak session never got HEALTHY, keeping the seed and refusing a second switch', async () => {
    await setSettings(manager, { cloak_enabled: true });
    const no = await seedSlot(1);
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
    const no = await seedSlot(1);
    expect((await switchTo(manager, no, 'cloak')).status).toBe(200);
    const { worker_token } = await claim('lab-1');
    await heartbeat(worker_token, 'HEALTHY');
    await heartbeat(worker_token, 'CHECKPOINT');
    const r = await switchTo(manager, no, 'stock');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cloak_proven');
    expect((await deviceOf(no))!.browser_engine).toBe('cloak');
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
