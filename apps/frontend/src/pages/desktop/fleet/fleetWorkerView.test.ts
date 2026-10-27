import { describe, expect, it } from 'vitest';
import { NOW, WORKER_DETAIL, WORKER_STINTS } from './fixtures';
import {
  deviceText, erpCheckpoint, erpCityChips, erpCityLog, erpHistory, erpHistoryDot, erpProxyText, erpReloginProgress, erpWorkerStatus,
  sessionDaysLeft, taskVisit,
} from './fleetWorkerView';

const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const worker = WORKER_DETAIL.worker;

describe('erpWorkerStatus', () => {
  it('buckets an ERP worker as the homelab page does', () => {
    expect(erpWorkerStatus(worker, NOW)).toBe('live');
    expect(erpWorkerStatus({ ...worker, last_heartbeat_at: minutesAgo(8) }, NOW)).toBe('stale');
    expect(erpWorkerStatus({ ...worker, last_heartbeat_at: minutesAgo(60) }, NOW)).toBe('offline');
    expect(erpWorkerStatus({ ...worker, last_heartbeat_at: null }, NOW)).toBe('offline');
    expect(erpWorkerStatus({ ...worker, state: 'CHALLENGE_2FA' }, NOW)).toBe('attention');
    expect(erpWorkerStatus({ ...worker, state: 'DEGRADED' }, NOW)).toBe('live');
  });
});

describe('erpCheckpoint', () => {
  it('is the wall a parked worker reports, while it still reports', () => {
    expect(erpCheckpoint(worker, NOW)).toBeNull();
    const walled = { ...worker, state: 'CHECKPOINT', detail: { reason: 'wall', wall: 'captcha', url: 'https://www.facebook.com/checkpoint/1' } };
    expect(erpCheckpoint(walled, NOW)).toEqual({
      kind: 'captcha', state: 'CHECKPOINT', reason: 'wall', url: 'https://www.facebook.com/checkpoint/1', seenAt: worker.last_heartbeat_at,
    });
    // A lost session names its state when it carries no wall.
    expect(erpCheckpoint({ ...worker, state: 'SESSION_EXPIRED', detail: { reason: 'logged out mid-sweep' } }, NOW)?.kind).toBe('SESSION_EXPIRED');
    // A silent worker is offline, not an open checkpoint.
    expect(erpCheckpoint({ ...walled, last_heartbeat_at: minutesAgo(60) }, NOW)).toBeNull();
  });
});

describe('the card rows', () => {
  it('reads the session expiry the monitor reports', () => {
    expect(Math.round(sessionDaysLeft(worker, NOW)!)).toBe(40);
    expect(sessionDaysLeft({ ...worker, detail: null }, NOW)).toBeNull();
  });
  it('names the proxy by its label, host:port and clock, never a URL', () => {
    expect(erpProxyText(WORKER_DETAIL)).toEqual({ label: 'Decodo NY 1', where: 'isp.example.net:10001 · America/New_York' });
    expect(erpProxyText({ ...WORKER_DETAIL, proxy: null })).toBe('unlisted');
    expect(erpProxyText({ ...WORKER_DETAIL, proxy: null, slot: { ...WORKER_DETAIL.slot!, has_proxy: false } })).toBeNull();
  });
  it('says the device in one line', () => {
    expect(deviceText(WORKER_DETAIL.slot!.device)).toBe('1366×768 · America/New_York · en-US');
    expect(deviceText({ viewport: [1440, 900], device_scale_factor: 1.25, timezone: 'UTC', locale: 'en-US' })).toBe('1440×900 @1.25 · UTC · en-US');
    expect(deviceText(null)).toBeNull();
  });
  it('puts home cities first and counts their alerts', () => {
    const chips = erpCityChips(WORKER_DETAIL, NOW);
    expect(chips.home.map(c => c.slug)).toEqual(['philly']);
    expect(chips.other.map(c => c.name)).toEqual(['Denver, CO']);
    expect(chips.hits.get('philly')).toEqual({ sent: 2, hit: 0 });
    expect(chips.hits.has('denver')).toBe(false);
    expect([...chips.searched]).toEqual(['philly', 'denver']);
  });
});

describe('erpCityLog', () => {
  it('turns each task into a city visit with its counts and outcome', () => {
    const [now, stopped, done] = erpCityLog(WORKER_DETAIL);
    expect(now).toMatchObject({ outcome: 'searching', name: 'Philadelphia, PA', why: 'home', worker_id: 'worker-60-14-1' });
    expect(stopped).toMatchObject({ outcome: 'stopped', reason: 'wall', wall: 'checkpoint', name: 'Denver, CO', reported: true });
    expect(done).toMatchObject({ outcome: 'finished', seconds: 520, reported: true });
    expect(done.totals).toMatchObject({ searches: 2, cards: 90, title_pass: 35, opened: 7, alerted: 2 });
    // The server's own done event is not a step the table knows.
    expect(done.events.map(e => e.event)).toEqual(['handed', 'searched', 'searched', 'finished']);
  });
  it('sums the searched events when the worker sent no report', () => {
    const v = taskVisit({ ...WORKER_DETAIL.log[2], result: null, state: 'expired' }, new Map());
    expect(v).toMatchObject({ outcome: 'expired', reported: false, name: null });
    expect(v.totals.cards).toBe(90);
  });
});

describe('erpHistory', () => {
  it('merges task events and stints, newest first', () => {
    const lines = erpHistory(WORKER_DETAIL.events, WORKER_STINTS);
    expect(lines.map(l => l.kind)).toEqual(['task', 'task', 'task', 'signon']);
    expect(lines.map(erpHistoryDot)).toEqual(['ff-attention', 'ff-attention', 'ff-live', 'ff-tl-muted']);
    const left = erpHistory([], [{ ...WORKER_STINTS[0], endedAt: NOW - 1000, outcome: 'problem' }]);
    expect(left.map(l => [l.kind, erpHistoryDot(l)])).toEqual([['left', 'ff-attention'], ['signon', 'ff-tl-muted']]);
  });
});

describe('erpReloginProgress', () => {
  const relogin = (requested: number, delivered: number | null) => ({
    id: 'r1', requested_at: minutesAgo(requested), requested_by: 'alex', delivered_at: delivered === null ? null : minutesAgo(delivered),
  });
  it('is queued until a heartbeat hands it over, then taken for a while', () => {
    expect(erpReloginProgress({ ...worker, relogin: null }, NOW)).toBeNull();
    expect(erpReloginProgress({ ...worker, relogin: relogin(1, null) }, NOW)).toMatchObject({ phase: 'queued', active: true });
    expect(erpReloginProgress({ ...worker, relogin: relogin(3, 2) }, NOW)).toMatchObject({ phase: 'signing_in', since: minutesAgo(2) });
    // Bounded: an old one is no strip at all.
    expect(erpReloginProgress({ ...worker, relogin: relogin(60, null) }, NOW)).toBeNull();
    expect(erpReloginProgress({ ...worker, relogin: relogin(20, 10) }, NOW)).toBeNull();
  });
  it('needs you once the worker reports Facebook’s prompt after the login had time to start', () => {
    const asking = { ...worker, state: 'CHALLENGE_2FA', relogin: relogin(3, 2) };
    expect(erpReloginProgress({ ...asking, last_heartbeat_at: minutesAgo(0) }, NOW)).toMatchObject({ phase: 'needs_you' });
    // The heartbeat that carried it still reports the old wall.
    expect(erpReloginProgress({ ...asking, last_heartbeat_at: minutesAgo(2) }, NOW)).toMatchObject({ phase: 'signing_in' });
    // A lost session is not Facebook asking.
    expect(erpReloginProgress({ ...asking, state: 'SESSION_EXPIRED', last_heartbeat_at: minutesAgo(0) }, NOW)).toMatchObject({ phase: 'signing_in' });
  });
});
