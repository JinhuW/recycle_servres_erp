import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { FLEET_CLOAK_MIN_WORKER_VERSION, type ClaimAnswer, type FleetCohortGroup, type FleetCohortReport } from '@recycle-erp/shared';
import { getTestDb, resetDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { ALEX, MARCUS, loginAs } from './helpers/auth';
import { sha256hex } from '../src/fleet/sql';
import { cohortReport } from '../src/fleet/cohorts';
import { poolKey, seal } from '../src/lib/sealed';

// The cohort report against the launch plan's measurement rules. Every account,
// host and proxy here is made up.

const NOW = new Date('2026-11-20T00:00:00Z');
const CLAIM = '2026-11-01T00:00:00Z';
const db = () => getTestDb();
const at = (hours: number, from = CLAIM) => new Date(new Date(from).getTime() + hours * 3_600_000).toISOString();

async function enroll(no: number, arm: 'cloak' | 'stock', opts: { batch?: string; pilot?: string | null; claimed?: string | null } = {}) {
  const pilot = opts.pilot === undefined ? 'p1' : opts.pilot;
  const claimed = opts.claimed === undefined ? CLAIM : opts.claimed;
  await db()`INSERT INTO fleet_pilot_enrollments (account_no, uid, batch, pilot_id, arm, seed, exit_ip, enrolled_at, first_claimed_at)
    VALUES (${no}, ${`uid-${no}`}, ${opts.batch ?? 'b1'}, ${pilot}, ${arm}, ${arm === 'cloak' ? no : null}, ${`203.0.113.${no}`}, ${at(-1)}, ${claimed})`;
}
async function pool(no: number, batch: string, status: string, holder: string | null) {
  const k = poolKey(testEnv)!;
  const uid = `6155${String(no).padStart(10, '0')}`;
  await db()`INSERT INTO fb_pool_accounts (no, uid, batch, status, holder_name, password_enc, totp_enc, cookie_enc, cookie_uid)
    OVERRIDING SYSTEM VALUE VALUES (${no}, ${uid}, ${batch}, ${status}, ${holder}, ${seal('p', k)}, ${seal('t', k)}, ${seal('c', k)}, ${uid})`;
}
async function stint(no: number, start: string, end: string | null, outcome: string | null, worker = `w-${no}`) {
  await db()`INSERT INTO fb_worker_accounts (worker_id, account_no, uid, started_at, ended_at, outcome)
    VALUES (${worker}, ${no}, ${`uid-${no}`}, ${start}, ${end}, ${outcome})`;
}
async function event(no: number, to: string, when: string, opts: { from?: string | null; reason?: string; engine?: string } = {}) {
  await db()`INSERT INTO fleet_worker_state_events (account_no, worker_id, engine, from_state, to_state, reason, at)
    VALUES (${no}, ${`w-${no}`}, ${opts.engine ?? 'stock'}, ${opts.from ?? null}, ${to}, ${opts.reason ?? null}, ${when})`;
}
const healthy = (no: number, hours = 1) => event(no, 'HEALTHY', at(hours));
async function search(no: number, when: string, stopped: boolean | string = false, state = 'done', kind = 'search') {
  await db()`INSERT INTO fleet_cities (slug, name, region) VALUES ('c', 'C', 'R') ON CONFLICT DO NOTHING`;
  await db()`INSERT INTO fleet_items (name, phrases) VALUES ('ram', '[]') ON CONFLICT DO NOTHING`;
  await db()`INSERT INTO fleet_tasks (city, item, kind, due_at, state, account_no, done_at, leased_at, result)
    VALUES ('c', 'ram', ${kind}, ${when}, ${state}, ${no}, ${when}, ${when}, ${db().json({ stopped } as never)})`;
}
async function exitChange(slots: number[], when: string, workers: string[] = []) {
  await db()`INSERT INTO fleet_proxy_exit_changes (exit, source, changed_at, previous_at, old_ip, new_ip, slots, workers)
    VALUES ('http://x:1', 'erp', ${when}, ${when}, '198.51.100.1', '198.51.100.2', ${slots}::int[], ${db().array(workers)}::text[])`;
}

const report = (pilot: string | null = 'p1', days = 30) => cohortReport(db(), { pilot, days }, NOW);
const arm = (r: FleetCohortReport, a: string): FleetCohortGroup => r.arms.find((g) => g.arm === a)!;

describe('cohort report', () => {
  beforeEach(async () => { await resetDb(); });

  it('splits by batch and arm and keeps counts beside percentages', async () => {
    await enroll(1, 'cloak', { batch: 'b1' }); await stint(1, CLAIM, at(5), 'retired');
    await enroll(2, 'cloak', { batch: 'b1' }); await stint(2, CLAIM, null, null); await healthy(2);
    await enroll(3, 'stock', { batch: 'b1' }); await stint(3, CLAIM, null, null); await healthy(3);
    await enroll(4, 'stock', { batch: 'b2' }); await stint(4, CLAIM, at(30), 'problem'); await healthy(4);
    await enroll(5, 'stock', { pilot: 'other' }); await stint(5, CLAIM, at(1), 'retired');

    const r = await report();
    expect(r.groups.map((g) => [g.batch, g.arm, g.claimed])).toEqual([['b1', 'cloak', 2], ['b1', 'stock', 1], ['b2', 'stock', 1]]);
    expect(arm(r, 'cloak').lost_24h.all).toMatchObject({ lost: 1, survived: 1, decided: 2, lost_pct: 50 });
    // Lost after 30 h: past the primary clock, inside the secondary one.
    expect(arm(r, 'stock').lost_24h.all).toMatchObject({ lost: 0, survived: 2, decided: 2, lost_pct: 0 });
    expect(arm(r, 'stock').lost_7d.all).toMatchObject({ lost: 1, survived: 1, decided: 2, lost_pct: 50 });
    expect(r.accounts.map((a) => a.account_no)).toEqual([1, 2, 3, 4]);
  });

  it('counts reaching HEALTHY, and starts the clocks at the enrollment first claim', async () => {
    // The old stint predates this enrollment's clock: its ending is not a loss here.
    await enroll(1, 'stock', { claimed: at(100) });
    await stint(1, at(-500), at(-400), 'problem');
    await stint(1, at(100), null, null);
    await event(1, 'HEALTHY', at(-450));
    await event(1, 'HEALTHY', at(101));
    const r = await report();
    expect(arm(r, 'stock')).toMatchObject({ claimed: 1, reached_healthy: 1, failed_starts: 0 });
    expect(r.accounts[0]).toMatchObject({ first_claimed_at: at(100), lost_at: null, outcome_24h: 'survived', outcome_7d: 'survived' });
  });

  it('keeps failed starts in their arm and in the denominator', async () => {
    // Retired without ever reaching HEALTHY.
    await enroll(1, 'cloak'); await stint(1, CLAIM, at(2), 'retired'); await event(1, 'DEAD', at(1), { from: 'DEGRADED' });
    // Never HEALTHY and never retired: no state rows at all, and no survivor.
    await enroll(2, 'cloak'); await stint(2, CLAIM, null, null);
    await enroll(3, 'cloak'); await stint(3, CLAIM, null, null); await healthy(3);
    const r = await report();
    const c = arm(r, 'cloak');
    expect(c.failed_starts).toBe(2);
    expect(c.lost_24h.all).toMatchObject({ lost: 1, never_healthy: 1, survived: 1, decided: 3, lost_pct: 33.3 });
    expect(r.accounts[1].reached_healthy).toBe(false);
  });

  it('shows enrolled but never claimed apart, in no window', async () => {
    await enroll(1, 'stock', { claimed: null });
    await enroll(2, 'stock'); await stint(2, CLAIM, at(1), 'retired');
    const r = await report();
    expect(arm(r, 'stock')).toMatchObject({ claimed: 1, never_claimed: 1 });
    expect(arm(r, 'stock').lost_24h.all).toMatchObject({ lost: 1, decided: 1, lost_pct: 100 });
    expect(r.accounts[0]).toMatchObject({ first_claimed_at: null, outcome_24h: null, outcome_7d: null, searches_7d: null });
  });

  it('reports an account released or held before its clock ends as unknown, not a survivor', async () => {
    // Handed back at hour 5, then retired after a re-add: the earlier ending stands.
    await enroll(1, 'stock'); await healthy(1); await stint(1, CLAIM, at(5), 'available'); await stint(1, at(6), at(10), 'retired');
    // Taken by a purchaser inside the 7 days, after the 24 h clock ended.
    await enroll(2, 'stock'); await healthy(2); await stint(2, CLAIM, at(48), 'taken');
    // Parked by a manager: no worker on the slot and an infinite lease.
    await pool(3, 'b1', 'fleet', 'w-3');
    await db()`INSERT INTO fleet_slots (account_no, lease_expires_at) VALUES (3, 'infinity')`;
    await enroll(3, 'stock'); await healthy(3);
    const r = await report();
    const s = arm(r, 'stock');
    expect(s.lost_24h.all).toMatchObject({ lost: 0, survived: 1, unknown: 2, decided: 1 });
    expect(s.lost_7d.all).toMatchObject({ lost: 0, survived: 0, unknown: 3, decided: 0, lost_pct: null });
    expect(r.accounts.map((a) => a.outcome_7d)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('leaves a clock that is still running out of the denominator', async () => {
    const recent = at(-3, NOW.toISOString());
    await enroll(1, 'cloak', { claimed: recent }); await stint(1, recent, null, null);
    const c = arm(await report(), 'cloak');
    expect(c.lost_24h.all).toMatchObject({ running: 1, decided: 0, lost_pct: null });
    expect(c.failed_starts).toBe(0);
    expect(c.searches.all).toEqual({ accounts: 0, searches: 0, per_account: null });
  });

  it('marks a survivor whose worker sat in a loss state when the clock ended', async () => {
    await enroll(1, 'stock'); await stint(1, CLAIM, null, null); await healthy(1); await event(1, 'CHECKPOINT', at(3), { from: 'HEALTHY' });
    const s = arm(await report(), 'stock');
    expect(s.lost_24h.all).toMatchObject({ survived: 1, survived_in_loss_state: 1 });
  });

  describe('the failed figure', () => {
    it('counts a checkpoint at hour 3 retired on day 3 as failed at 24 h, not as stint lost', async () => {
      await enroll(1, 'cloak'); await healthy(1); await event(1, 'CHECKPOINT', at(3), { from: 'HEALTHY' });
      await stint(1, CLAIM, at(72), 'retired');
      const c = arm(await report(), 'cloak');
      expect(c.lost_24h.all).toMatchObject({ failed: 1, failed_pct: 100, lost: 0, lost_pct: 0, survived: 1, survived_in_loss_state: 1, decided: 1 });
      expect(c.lost_7d.all).toMatchObject({ failed: 1, failed_pct: 100, lost: 1, lost_pct: 100, survived: 0, decided: 1 });
      expect((await report()).accounts[0]).toMatchObject({ outcome_24h: 'survived', in_loss_state_24h: true, outcome_7d: 'lost', in_loss_state_7d: false });
    });

    it('counts never reaching HEALTHY by the end of the window as failed', async () => {
      await enroll(1, 'cloak'); await stint(1, CLAIM, null, null);
      await enroll(2, 'cloak'); await stint(2, CLAIM, null, null); await healthy(2, 1);
      const c = arm(await report(), 'cloak').lost_24h.all;
      expect(c).toMatchObject({ failed: 1, failed_pct: 50, lost: 0, lost_pct: 0, never_healthy: 1, survived: 1, decided: 2 });
    });

    it('does not count a checkpoint that recovered to HEALTHY before the end of the window', async () => {
      await enroll(1, 'stock'); await stint(1, CLAIM, null, null); await healthy(1);
      await event(1, 'CHECKPOINT', at(3), { from: 'HEALTHY' });
      await event(1, 'HEALTHY', at(10), { from: 'CHECKPOINT' });
      expect(arm(await report(), 'stock').lost_24h.all).toMatchObject({ failed: 0, failed_pct: 0, survived: 1, survived_in_loss_state: 0 });
    });

    it('leaves an account the owner released as unknown, even from a checkpoint', async () => {
      await enroll(1, 'stock'); await healthy(1); await event(1, 'CHECKPOINT', at(3), { from: 'HEALTHY' });
      await stint(1, CLAIM, at(5), 'available');
      expect(arm(await report(), 'stock').lost_24h.all).toMatchObject({ failed: 0, failed_pct: null, unknown: 1, decided: 0 });
    });

    it('is figured apart without flagged accounts', async () => {
      await enroll(1, 'cloak'); await stint(1, CLAIM, null, null); await exitChange([1], at(2));
      await enroll(2, 'cloak'); await stint(2, CLAIM, null, null); await healthy(2);
      const w = arm(await report(), 'cloak').lost_24h;
      expect(w.all).toMatchObject({ failed: 1, failed_pct: 50, decided: 2 });
      expect(w.unflagged).toMatchObject({ failed: 0, failed_pct: 0, decided: 1 });
    });

    it('stays the stint rule alone for an account with no state history', async () => {
      const old = at(-72, NOW.toISOString());
      await stint(1, old, at(5, old), 'retired');
      await stint(2, old, null, null);
      const [g] = (await report(null)).groups;
      expect(g.lost_24h.all).toMatchObject({ failed: 1, lost: 1, failed_pct: 50, lost_pct: 50, decided: 2 });
    });
  });

  it('counts completed searches only inside the fixed 7 days from first claim', async () => {
    await enroll(1, 'cloak'); await stint(1, CLAIM, null, null); await healthy(1);
    await search(1, at(1));
    await search(1, at(167));
    await search(1, at(168)); // the window is half-open
    await search(1, at(-1));
    await search(1, at(2), true); // stopped
    await search(1, at(5), 'wall (checkpoint)'); // how workers really say it
    await search(1, at(6), 'no result');
    await search(1, at(3), false, 'expired');
    await search(1, at(4), false, 'done', 'probe');
    // An early loss keeps its short count: doing badly can't drop an account.
    await enroll(2, 'cloak'); await stint(2, CLAIM, at(4), 'retired'); await healthy(2);
    await search(2, at(2));
    const r = await report();
    expect(arm(r, 'cloak').searches.all).toEqual({ accounts: 2, searches: 3, per_account: 1.5 });
    expect(r.accounts.map((a) => a.searches_7d)).toEqual([2, 1]);
  });

  it('flags exit changes and licence outages from first claim on, with results with and without them', async () => {
    // Touched inside 24 h.
    await enroll(1, 'cloak'); await stint(1, CLAIM, at(5), 'retired'); await healthy(1); await exitChange([1], at(2));
    // Licence outage inside 24 h.
    await enroll(2, 'cloak'); await stint(2, CLAIM, at(6), 'retired'); await healthy(2);
    await event(2, 'DEAD', at(3), { from: 'HEALTHY', reason: 'license_outage' });
    // Moved on day 3: flags the 7 d figure, not the 24 h one.
    await enroll(3, 'cloak'); await stint(3, CLAIM, null, null); await healthy(3); await exitChange([3], at(72));
    // Moved before its first claim, when the exit could still be re-recorded.
    await enroll(4, 'cloak'); await stint(4, CLAIM, null, null); await healthy(4); await exitChange([4], at(-1));
    // Moved after it was lost.
    await enroll(5, 'cloak'); await stint(5, CLAIM, at(1), 'problem'); await event(5, 'HEALTHY', at(0.5)); await exitChange([5], at(2));

    const c = arm(await report(), 'cloak');
    expect(c.exit_change_accounts).toBe(3);
    expect(c.outage_accounts).toBe(1);
    expect(c.lost_24h.all).toMatchObject({ lost: 3, survived: 2, decided: 5, lost_pct: 60 });
    expect(c.lost_24h.unflagged).toMatchObject({ lost: 1, survived: 2, decided: 3, lost_pct: 33.3 });
    expect(c.lost_7d.all).toMatchObject({ lost: 3, survived: 2, decided: 5 });
    expect(c.lost_7d.unflagged).toMatchObject({ lost: 1, survived: 1, decided: 2, lost_pct: 50 });
    expect(c.searches.unflagged.accounts).toBe(2);
  });

  it('counts each boot right after a licence outage exit as a recovery boot, per arm', async () => {
    await enroll(1, 'cloak'); await stint(1, CLAIM, null, null);
    await event(1, 'DEGRADED', at(0.1), { reason: 'booting' });
    await event(1, 'HEALTHY', at(1), { from: 'DEGRADED' });
    await event(1, 'DEAD', at(2), { from: 'HEALTHY', reason: 'license_outage' });
    await event(1, 'DEGRADED', at(3), { reason: 'booting' }); // a retry that opened no page counts too
    await event(1, 'DEAD', at(3.1), { from: 'DEGRADED', reason: 'license_outage' });
    await event(1, 'DEGRADED', at(4), { reason: 'booting' });
    await event(1, 'HEALTHY', at(5), { from: 'DEGRADED' });
    // A boot after any other exit is not a recovery.
    await event(1, 'DEAD', at(6), { from: 'HEALTHY', reason: 'connect_failed' });
    await event(1, 'DEGRADED', at(7), { reason: 'booting' });
    await enroll(2, 'stock'); await stint(2, CLAIM, null, null); await healthy(2);
    const r = await report();
    expect(arm(r, 'cloak').recovery_boots).toBe(2);
    expect(arm(r, 'stock').recovery_boots).toBe(0);
    expect(r.accounts[0]).toMatchObject({ licence_outages: 2, recovery_boots: 2 });
  });

  it('shows the cloak seats in use, parked counted, against the setting and the 18 cap', async () => {
    for (const [no, lease] of [[1, null], [2, 'infinity'], [3, null]] as const) {
      await pool(no, 'b1', 'fleet', 'ERP fleet');
      await db()`INSERT INTO fleet_slots (account_no, lease_expires_at, device)
        VALUES (${no}, CASE WHEN ${lease === 'infinity'}::boolean THEN 'infinity'::timestamptz END, ${db().json({ browser_engine: no === 3 ? 'stock' : 'cloak' } as never)})`;
    }
    await db()`INSERT INTO fleet_settings (key, value) VALUES ('cloak_max_slots', '12') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    expect((await report()).seats).toEqual({ active: 2, parked: 1, max_slots: 12, pilot_cap: 18 });
  });

  describe('without a pilot, as a supplier scorecard', () => {
    it('groups existing history by batch and engine, from the stints, without an enrollment', async () => {
      for (const [no, batch] of [[1, 'order-a'], [2, 'order-a'], [3, 'order-b']] as const) await pool(no, batch, 'retired', null);
      const old = at(-72, NOW.toISOString());
      // Lost in 24 h. No state history, so health can't be told and the stint rule decides.
      await stint(1, old, at(10, old), 'retired');
      // Survived; the slot's "ERP fleet" stint first doesn't start the clock.
      await stint(2, at(-200, old), at(-1, old), 'fleet', 'ERP fleet');
      await stint(2, old, null, null);
      // Started on CloakBrowser, by its first state event.
      await stint(3, old, at(30, old), 'problem');
      await db()`INSERT INTO fleet_worker_state_events (account_no, worker_id, engine, from_state, to_state, at) VALUES (3, 'w-3', 'cloak', NULL, 'HEALTHY', ${at(1, old)})`;
      // Outside the 30 days.
      await stint(4, at(-1000, NOW.toISOString()), at(-999, NOW.toISOString()), 'retired');

      const r = await report(null);
      expect(r.pilot).toBeNull();
      expect(r.days).toBe(30);
      expect(r.accounts).toEqual([]);
      expect(r.groups.map((g) => [g.batch, g.arm, g.claimed])).toEqual([['order-a', 'stock', 2], ['order-b', 'cloak', 1]]);
      expect(r.groups[0]).toMatchObject({ health_unknown: 2, failed_starts: 0 });
      expect(r.groups[0].lost_24h.all).toMatchObject({ lost: 1, survived: 1, decided: 2, lost_pct: 50 });
      expect(r.groups[0].lost_7d.all).toMatchObject({ lost: 1, running: 1, decided: 1 });
      expect(r.groups[1].lost_24h.all).toMatchObject({ lost: 0, survived: 1, decided: 1 });
      expect(r.groups[1].lost_7d.all).toMatchObject({ lost: 1, decided: 1, lost_pct: 100 });
      // No ERP tasks exist for an account with no state history: that says nothing about its searches.
      expect(r.groups[0].searches.all.accounts).toBe(0);
    });

    it('takes a removed account whose pool row is gone, in a batch of its own', async () => {
      const old = at(-48, NOW.toISOString());
      await stint(9, old, at(2, old), 'removed');
      const r = await report(null);
      expect(r.groups).toHaveLength(1);
      expect(r.groups[0]).toMatchObject({ batch: null, arm: 'stock', claimed: 1 });
      expect(r.groups[0].lost_24h.all).toMatchObject({ unknown: 1, lost: 0 });
    });

    it('flags a homelab stint by the worker named on the exit change, only while it ran', async () => {
      const old = at(-48, NOW.toISOString());
      await stint(1, old, null, null);
      await exitChange([], at(1, old), ['W-1']); // the ledger names a worker however its holder was typed
      await stint(2, old, at(20, old), 'fleet');
      await exitChange([], at(25, old), ['w-2']);
      const r = await report(null);
      expect(r.groups[0].exit_change_accounts).toBe(1);
    });
  });
});

describe('cohort report, through the live routes', () => {
  const HOST_TOKEN = 'host-' + randomBytes(16).toString('hex');
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await resetDb();
    await db()`INSERT INTO fleet_hosts (host_id, token_hash, capacity, authoritative) VALUES ('lab', ${sha256hex(HOST_TOKEN)}, 2, TRUE)`;
  });

  it('still counts a retired account as lost once its slot row is gone', async () => {
    const k = poolKey(testEnv)!;
    const [a] = await db()<{ no: number }[]>`
      INSERT INTO fb_pool_accounts (uid, batch, status, holder_name, password_enc, totp_enc, cookie_enc, cookie_uid)
      VALUES ('61550000000001', 'fixtures', 'fleet', 'ERP fleet', ${seal('pw', k)}, ${seal('abcd efgh', k)}, ${seal('c_user=61550000000001; xs=x', k)}, '61550000000001')
      RETURNING no`;
    await db()`INSERT INTO fleet_slots (account_no, proxy_url) VALUES (${a.no}, ${seal('http://u:p@exit.example:10000', k)})`;
    await db()`INSERT INTO fleet_pilot_enrollments (account_no, uid, batch, pilot_id, arm, exit_ip)
      VALUES (${a.no}, '61550000000001', 'fixtures', 'p1', 'stock', '203.0.113.9')`;

    const claim = await api<ClaimAnswer>('POST', '/api/fleet/worker/claim', {
      headers: bearer(HOST_TOKEN), body: { host_id: 'lab', worker_id: 'lab-1', version: FLEET_CLOAK_MIN_WORKER_VERSION, vnc_port: 5901 },
    });
    expect(claim.status).toBe(200);
    const beat = (state: string) => api('POST', '/api/fleet/worker/heartbeat', {
      headers: bearer(claim.body.worker_token), body: { state, version: FLEET_CLOAK_MIN_WORKER_VERSION, detail: null },
    });
    expect((await beat('HEALTHY')).status).toBe(200);
    expect((await beat('CHECKPOINT')).status).toBe(200);

    const { token } = await loginAs(ALEX);
    expect((await api('POST', `/api/fleet/slots/${a.no}/retire`, { token, body: {} })).status).toBe(200);
    expect(await db()`SELECT 1 FROM fleet_slots WHERE account_no = ${a.no}`).toHaveLength(0);

    const r = await api<FleetCohortReport>('GET', '/api/fleet/stats/cohorts?pilot=p1', { token });
    expect(r.status).toBe(200);
    expect(r.body.arms[0]).toMatchObject({ arm: 'stock', claimed: 1, never_claimed: 0, reached_healthy: 1, failed_starts: 0 });
    expect(r.body.arms[0].lost_24h.all).toMatchObject({ lost: 1, decided: 1, lost_pct: 100 });
    expect(r.body.pilots).toEqual(['p1']);

    // The pool row gone too: stints and the enrollment still answer.
    await db()`DELETE FROM fb_pool_accounts WHERE no = ${a.no}`;
    const after = await api<FleetCohortReport>('GET', '/api/fleet/stats/cohorts?pilot=p1', { token });
    expect(after.body.arms[0].lost_24h.all).toMatchObject({ lost: 1, decided: 1 });
    expect(after.body.groups[0].batch).toBe('fixtures');
  });

  it('is manager-only, and refuses a bad pilot or range', async () => {
    const { token } = await loginAs(ALEX);
    expect((await api('GET', '/api/fleet/stats/cohorts', { token })).status).toBe(200);
    expect((await api('GET', '/api/fleet/stats/cohorts?days=0', { token })).status).toBe(422);
    expect((await api('GET', `/api/fleet/stats/cohorts?pilot=${encodeURIComponent('a b')}`, { token })).status).toBe(422);
    expect((await api('GET', '/api/fleet/stats/cohorts', { token: (await loginAs(MARCUS)).token })).status).toBe(403);
    expect((await api('GET', '/api/fleet/stats/cohorts')).status).toBe(401);
  });

  it('writes nothing', async () => {
    const { token } = await loginAs(ALEX);
    const tables = ['fleet_pilot_enrollments', 'fb_worker_accounts', 'fb_pool_events', 'fleet_worker_state_events', 'fleet_slots', 'fleet_workers'];
    const snapshot = async () => Promise.all(tables.map(async (t) => (await db()`SELECT COUNT(*)::int AS n FROM ${db()(t)}`)[0].n));
    await enroll(1, 'stock'); await stint(1, CLAIM, null, null);
    const before = await snapshot();
    expect((await api('GET', '/api/fleet/stats/cohorts?pilot=p1', { token })).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });
});
