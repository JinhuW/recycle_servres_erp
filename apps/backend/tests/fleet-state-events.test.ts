import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { ClaimAnswer, FleetEngineLoss } from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { sha256hex } from '../src/fleet/sql';
import { engineLoss } from '../src/fleet/stateEvents';
import { poolKey, seal } from '../src/lib/sealed';

// The worker state history the heartbeat keeps, and the per-engine loss rate
// read from it. Every account, host, token and proxy here is made up.

const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function seedAccount(n: number, device: Record<string, unknown> | null = null): Promise<number> {
  const db = getTestDb();
  const k = poolKey(testEnv)!;
  const uid = `6155000000000${n}`;
  const [a] = await db<{ no: number }[]>`
    INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, totp_enc, cookie_enc, cookie_uid)
    VALUES (${uid}, 'fixtures', 'fleet', ${`old-worker-${n}`}, ${seal(`pw-${n}`, k)}, ${seal(`abcd efgh-${n}`, k)},
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

const heartbeat = (token: string, state: string, detail: Record<string, unknown> | null = null) =>
  api('POST', '/api/fleet/worker/heartbeat', { headers: bearer(token), body: { state, version: '0.15.0', detail } });

const stateEvents = () => getTestDb()<{ account_no: number; worker_id: string; engine: string; from_state: string | null; to_state: string; reason: string | null }[]>`
  SELECT account_no, worker_id, engine, from_state, to_state, reason FROM fleet_worker_state_events ORDER BY id`;

describe('fleet_worker_state_events', () => {
  beforeEach(async () => {
    await resetDb();
    await getTestDb()`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 2, TRUE)`;
  });

  it('writes a row when the state changes and none when it repeats', async () => {
    const no = await seedAccount(1);
    const { worker_token } = await claim('lab-1');
    expect((await heartbeat(worker_token, 'HEALTHY')).status).toBe(200);
    expect((await heartbeat(worker_token, 'HEALTHY')).status).toBe(200);
    expect((await heartbeat(worker_token, 'CHECKPOINT', { reason: 'checkpoint_page' })).status).toBe(200);
    expect((await heartbeat(worker_token, 'CHECKPOINT', { reason: 'checkpoint_page' })).status).toBe(200);
    expect(await stateEvents()).toEqual([
      { account_no: no, worker_id: 'lab-1', engine: 'stock', from_state: null, to_state: 'HEALTHY', reason: null },
      { account_no: no, worker_id: 'lab-1', engine: 'stock', from_state: 'HEALTHY', to_state: 'CHECKPOINT', reason: 'checkpoint_page' },
    ]);
  });

  it('stamps the engine the slot\'s device names at that moment', async () => {
    const no = await seedAccount(2, { user_agent: 'x', browser_engine: 'cloak', cloak_seed: 12345 });
    const { worker_token } = await claim('lab-2');
    await heartbeat(worker_token, 'HEALTHY');
    await getTestDb()`UPDATE fleet_slots SET device = device - 'browser_engine' WHERE account_no = ${no}`;
    await heartbeat(worker_token, 'SESSION_EXPIRED');
    expect((await stateEvents()).map((e) => [e.engine, e.to_state])).toEqual([['cloak', 'HEALTHY'], ['stock', 'SESSION_EXPIRED']]);
  });

  it('writes nothing for a heartbeat refused on a stale epoch', async () => {
    await seedAccount(3);
    const first = await claim('lab-3');
    await heartbeat(first.worker_token, 'HEALTHY');
    await getTestDb()`UPDATE fleet_slots SET epoch = epoch + 1`;
    expect((await heartbeat(first.worker_token, 'CHECKPOINT')).status).toBe(409);
    expect((await stateEvents()).map((e) => e.to_state)).toEqual(['HEALTHY']);
  });
});

describe('engineLoss', () => {
  const NOW = new Date('2026-10-31T00:00:00Z');
  const db = () => getTestDb();

  async function stint(no: number, worker: string, start: string, end: string | null, outcome: string | null) {
    await db()`INSERT INTO fb_worker_accounts (worker_id, account_no, uid, started_at, ended_at, outcome)
               VALUES (${worker}, ${no}, ${`uid-${no}`}, ${start}, ${end}, ${outcome})`;
  }
  async function event(no: number, worker: string, engine: string, to: string, at: string) {
    await db()`INSERT INTO fleet_worker_state_events (account_no, worker_id, engine, to_state, at)
               VALUES (${no}, ${worker}, ${engine}, ${to}, ${at})`;
  }

  beforeEach(async () => { await resetDb(); });

  it('splits account-days by engine and counts each entry into a lost state once', async () => {
    // Account 1, stock, on an ERP worker for the whole 10-day window: one
    // checkpoint, seen again after a reboot and a move to SESSION_EXPIRED.
    await stint(1, 'lab-1', '2026-10-01T00:00:00Z', null, null);
    await event(1, 'lab-1', 'stock', 'HEALTHY', '2026-10-21T06:00:00Z');
    await event(1, 'lab-1', 'stock', 'CHECKPOINT', '2026-10-25T00:00:00Z');
    await event(1, 'lab-1', 'stock', 'CHECKPOINT', '2026-10-25T01:00:00Z');
    await event(1, 'lab-1', 'stock', 'SESSION_EXPIRED', '2026-10-26T00:00:00Z');
    // Account 2: stock for 2 days, then switched to cloak for 4; one challenge.
    await stint(2, 'lab-2', '2026-10-25T00:00:00Z', '2026-10-31T00:00:00Z', 'fleet');
    await event(2, 'lab-2', 'stock', 'HEALTHY', '2026-10-25T00:01:00Z');
    await event(2, 'lab-2', 'stock', 'CHECKPOINT', '2026-10-27T00:00:00Z');
    await event(2, 'lab-2', 'cloak', 'HEALTHY', '2026-10-27T00:00:00Z');
    await event(2, 'lab-2', 'cloak', 'CHALLENGE_CAPTCHA', '2026-10-30T00:00:00Z');
    // A homelab stint (no state events for its worker) is not ERP exposure,
    // and an event before the window is not a loss in it.
    await stint(3, 'homelab-9', '2026-10-01T00:00:00Z', '2026-10-28T00:00:00Z', 'problem');
    await event(1, 'lab-1', 'stock', 'HEALTHY', '2026-10-20T00:00:00Z');

    const r: FleetEngineLoss = await engineLoss(db(), 10, NOW);
    expect(r.since).toBe('2026-10-21T00:00:00.000Z');
    const stock = r.engines.find((e) => e.engine === 'stock')!;
    const cloak = r.engines.find((e) => e.engine === 'cloak')!;
    // 10 days for account 1 plus 2 for account 2.
    expect(stock).toEqual({
      engine: 'stock', account_days: 12, losses: { CHECKPOINT: 2 }, total_losses: 2, losses_per_100_account_days: 16.67,
    });
    expect(cloak).toEqual({
      engine: 'cloak', account_days: 4, losses: { CHALLENGE_CAPTCHA: 1 }, total_losses: 1, losses_per_100_account_days: 25,
    });
    // Retro: every stint's days in the window (10 + 6 + 7) and the problem ending.
    expect(r.retro).toEqual({
      engine: 'stock', account_days: 23, losses: { problem: 1, retired: 0 }, total_losses: 1, losses_per_100_account_days: 4.35,
    });
  });

  it('answers a null rate with no exposure', async () => {
    const r = await engineLoss(db(), 30, NOW);
    expect(r.engines).toEqual([
      { engine: 'stock', account_days: 0, losses: {}, total_losses: 0, losses_per_100_account_days: null },
      { engine: 'cloak', account_days: 0, losses: {}, total_losses: 0, losses_per_100_account_days: null },
    ]);
    expect(r.retro.losses_per_100_account_days).toBeNull();
  });

  it('is a manager-only route with a bounded window', async () => {
    const manager = (await loginAs(ALEX)).token;
    const ok = await api<FleetEngineLoss>('GET', '/api/fleet/stats/engine-loss?days=30', { token: manager });
    expect(ok.status).toBe(200);
    expect(ok.body.days).toBe(30);
    expect((await api('GET', '/api/fleet/stats/engine-loss?days=0', { token: manager })).status).toBe(422);
    expect((await api('GET', '/api/fleet/stats/engine-loss', { token: (await loginAs(MARCUS)).token })).status).toBe(403);
  });
});
