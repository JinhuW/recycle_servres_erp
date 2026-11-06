import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { FLEET_CLOAK_MIN_WORKER_VERSION, fleetCloakFor, type ClaimAnswer, type FleetProfileLaunchFacts } from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { sha256hex } from '../src/fleet/sql';
import { launchFingerprint } from '../src/fleet/profile';
import { ALEX, loginAs } from './helpers/auth';
import { poolKey, seal } from '../src/lib/sealed';

// Every account, host and hash here is made up.

const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const hash = (c: string) => c.repeat(64);

const facts = (seed: number, over: Partial<FleetProfileLaunchFacts> = {}): FleetProfileLaunchFacts => ({
  cloak_seed: seed, canvas_sha256: hash('a'), webgl_sha256: hash('b'), hardware_concurrency: 8, device_memory: 8,
  screen: [1920, 1080], platform: 'Win32', languages: ['en-US', 'en'],
  user_agent: 'Mozilla/5.0 Chrome/155.0.0.0', build: '155.0.8059.39.2', ...over,
});

async function seedCloak(n: number): Promise<{ no: number; seed: number }> {
  const db = getTestDb();
  const k = poolKey(testEnv)!;
  const uid = `615500000${n}`;
  const [{ no }] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, totp_enc, cookie_enc, cookie_uid)
    VALUES (${uid}, 'fixtures', 'fleet', 'ERP fleet', ${seal('pw', k)}, ${seal('abcd', k)}, ${seal(`c_user=${uid}; xs=x; datr=d`, k)}, ${uid})
    RETURNING no`;
  const { cloak_seed: seed, cloak_gpu: gpu } = fleetCloakFor(no);
  await db`UPDATE fb_pool_accounts SET browser_engine = 'cloak', cloak_seed = ${seed}, cloak_gpu = ${gpu}, profile_timezone = 'America/Denver' WHERE no = ${no}`;
  await db`INSERT INTO fleet_slots (account_no, proxy_url, device)
           VALUES (${no}, ${seal(`http://u:p@exit-${n}.example:1`, k)}, ${db.json({ viewport: [1366, 645], screen: [1366, 768], timezone: 'America/Denver', locale: 'en-US', browser_engine: 'cloak', cloak_seed: seed, cloak_gpu: gpu })})`;
  return { no, seed };
}

async function claimed(workerId: string): Promise<ClaimAnswer> {
  const r = await api<ClaimAnswer>('POST', '/api/fleet/worker/claim', {
    headers: { Authorization: `Bearer ${HOST_TOKEN}` },
    body: { host_id: 'lab', worker_id: workerId, version: FLEET_CLOAK_MIN_WORKER_VERSION, vnc_port: 5901 },
  });
  expect(r.status).toBe(200);
  return r.body;
}

const report = (token: string, f: unknown) =>
  api<{ verdict: string; error?: string }>('POST', '/api/fleet/worker/profile-launch', { headers: { Authorization: `Bearer ${token}` }, body: f });

const row = async (no: number) => (await getTestDb()<{
  cloak_seed: number; cloak_gpu: string; profile_first_launched_at: Date | null; profile_fingerprint: string | null;
  profile_launch: Record<string, unknown> | null; profile_launch_changed: Record<string, unknown> | null; profile_device: unknown;
}[]>`SELECT cloak_seed, cloak_gpu, profile_first_launched_at, profile_fingerprint, profile_launch, profile_launch_changed, profile_device FROM fb_pool_accounts WHERE no = ${no}`)[0];

describe('POST /api/fleet/worker/profile-launch', () => {
  beforeEach(async () => {
    await resetDb();
    await getTestDb()`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 3, TRUE)`;
  });

  it('links the first launch, then matches every later one', async () => {
    const { no, seed } = await seedCloak(9001);
    const a = await claimed('lab-1');
    expect((await report(a.worker_token, facts(seed))).body.verdict).toBe('linked');
    const first = await row(no);
    expect(first.profile_first_launched_at).not.toBeNull();
    expect(first.profile_fingerprint).toBe(launchFingerprint(facts(seed)));
    expect(first.profile_launch).toMatchObject({ build: '155.0.8059.39.2', worker_id: 'lab-1', host_id: 'lab', epoch: a.epoch });
    expect((await report(a.worker_token, facts(seed))).body.verdict).toBe('match');
    expect((await row(no)).profile_first_launched_at).toEqual(first.profile_first_launched_at);
  });

  it('does not count a new build alone as a change', async () => {
    const { seed } = await seedCloak(9001);
    const a = await claimed('lab-1');
    await report(a.worker_token, facts(seed));
    const r = await report(a.worker_token, facts(seed, { build: '156.0', user_agent: 'Mozilla/5.0 Chrome/156.0.0.0' }));
    expect(r.body.verdict).toBe('match');
  });

  it('parks a changed fingerprint until a manager accepts it, then the worker matches', async () => {
    const { no, seed } = await seedCloak(9001);
    const a = await claimed('lab-1');
    await report(a.worker_token, facts(seed));
    const was = (await row(no)).profile_fingerprint;
    const moved = facts(seed, { canvas_sha256: hash('c'), build: '156.0' });
    expect((await report(a.worker_token, moved)).body.verdict).toBe('changed');
    expect((await row(no)).profile_fingerprint).toBe(was);

    const hb = await api('POST', '/api/fleet/worker/heartbeat', {
      headers: { Authorization: `Bearer ${a.worker_token}` }, body: { state: 'DEAD', version: FLEET_CLOAK_MIN_WORKER_VERSION, detail: { reason: 'profile_changed' } },
    });
    expect(hb.status).toBe(200);
    const auth = await loginAs(ALEX);
    const accepted = await api<{ slot: { profile: { changed: boolean; build: string } } }>('POST', `/api/fleet/slots/${no}/profile/accept`, { token: auth.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.slot.profile).toMatchObject({ changed: false, build: '156.0' });
    const [w] = await getTestDb()<{ resume_id: string | null }[]>`SELECT resume_id FROM fleet_workers WHERE worker_id = 'lab-1'`;
    expect(w.resume_id).not.toBeNull();
    expect((await report(a.worker_token, moved)).body.verdict).toBe('match');
    expect((await api<{ error: string }>('POST', `/api/fleet/slots/${no}/profile/accept`, { token: auth.token })).body.error).toBe('no_profile_change');
  });

  it('draws a new seed when a first launch looks like another account', async () => {
    const one = await seedCloak(9001);
    const two = await seedCloak(9002);
    const a = await claimed('lab-1');
    const b = await claimed('lab-2');
    expect((await report(a.worker_token, facts(a.account.no === one.no ? one.seed : two.seed))).body.verdict).toBe('linked');
    const late = b.account.no;
    const lateSeed = late === one.no ? one.seed : two.seed;
    expect((await report(b.worker_token, facts(lateSeed))).body.verdict).toBe('redraw');
    const after = await row(late);
    expect(after.cloak_seed).toBe(fleetCloakFor(late, 1).cloak_seed);
    expect(after.profile_first_launched_at).toBeNull();
    const [slot] = await getTestDb()<{ device: Record<string, unknown> }[]>`SELECT device FROM fleet_slots WHERE account_no = ${late}`;
    expect(slot.device).toMatchObject({ cloak_seed: after.cloak_seed, cloak_gpu: after.cloak_gpu, screen: [1366, 768] });
    // An answer that went missing: the old browser asks again.
    expect((await report(b.worker_token, facts(lateSeed))).body.verdict).toBe('redraw');
    expect((await row(late)).cloak_seed).toBe(after.cloak_seed);
    expect((await report(b.worker_token, facts(after.cloak_seed, { canvas_sha256: hash('d') }))).body.verdict).toBe('linked');
  });

  it('keeps the seed and alerts when the look-alike has already reached Facebook', async () => {
    const one = await seedCloak(9001);
    const two = await seedCloak(9002);
    const a = await claimed('lab-1');
    const b = await claimed('lab-2');
    const seedOf = (no: number) => (no === one.no ? one.seed : two.seed);
    await report(a.worker_token, facts(seedOf(a.account.no)));
    await getTestDb()`INSERT INTO fleet_worker_state_events (account_no, worker_id, to_state, engine, at)
      VALUES (${b.account.no}, 'lab-2', 'HEALTHY', 'cloak', NOW() - INTERVAL '1 day')`;
    expect((await report(b.worker_token, facts(seedOf(b.account.no)))).body.verdict).toBe('duplicate');
    const after = await row(b.account.no);
    expect(after.cloak_seed).toBe(seedOf(b.account.no));
    expect(after.profile_fingerprint).not.toBeNull();
    const notes = await getTestDb()`SELECT 1 FROM notifications WHERE kind = 'fleet_profile_duplicate'`;
    expect(notes.length).toBeGreaterThan(0);
  });

  it('lets only one of two first launches on one fingerprint link', async () => {
    const one = await seedCloak(9001);
    const two = await seedCloak(9002);
    const a = await claimed('lab-1');
    const b = await claimed('lab-2');
    const seedOf = (no: number) => (no === one.no ? one.seed : two.seed);
    const answers = await Promise.all([
      report(a.worker_token, facts(seedOf(a.account.no))),
      report(b.worker_token, facts(seedOf(b.account.no))),
    ]);
    expect(answers.map((r) => r.body.verdict).sort()).toEqual(['linked', 'redraw']);
  });

  it('refuses a stale epoch and a malformed report', async () => {
    const { no, seed } = await seedCloak(9001);
    const a = await claimed('lab-1');
    expect((await report(a.worker_token, { ...facts(seed), canvas_sha256: 'nope' })).status).toBe(422);
    await getTestDb()`UPDATE fleet_slots SET epoch = epoch + 1 WHERE account_no = ${no}`;
    expect((await report(a.worker_token, facts(seed))).status).not.toBe(200);
    expect((await row(no)).profile_fingerprint).toBeNull();
  });

  it('holds seeds apart on slots as well', async () => {
    const one = await seedCloak(9001);
    const two = await seedCloak(9002);
    await expect(getTestDb()`UPDATE fleet_slots SET device = device || ${getTestDb().json({ cloak_seed: one.seed })} WHERE account_no = ${two.no}`)
      .rejects.toThrow(/fleet_slots_cloak_seed_key/);
  });
});
