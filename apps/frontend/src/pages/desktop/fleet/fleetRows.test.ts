import { describe, expect, it } from 'vitest';
import { COORDINATOR, NOW, POOL, RELEASE, SLOTS, WORKERS } from './fixtures';
import { FLEET_ROW_KINDS, filterFleetRows, fleetRowCounts, fleetRowHosts, fleetRowKinds, fleetRows, fleetRunning } from './fleetRows';

const input = { slots: SLOTS, workers: WORKERS, release: RELEASE, coordinator: COORDINATOR, challenges: null, pool: POOL };
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe('fleetRows', () => {
  it('does not duplicate a pool account mentioned by an old coordinator worker', () => {
    const worker = { ...COORDINATOR.workers[0], worker_id: 'retired-worker', session: { ...COORDINATOR.workers[0].session!, fb_user_id: POOL[0].uid } };
    const rows = fleetRows({ ...input, coordinator: { ...COORDINATOR, workers: [worker] } }, NOW);
    expect(rows.some(r => r.key === 'coord:retired-worker')).toBe(false);
  });
  const rows = fleetRows(input, NOW);
  const by = (key: string) => rows.find(r => r.key === key)!;

  it('is one row per worker, running ones first, by worker id; idle accounts are not rows', () => {
    expect(rows.map(r => r.key)).toEqual([
      'erp:homelab-1', 'erp:homelab-2', 'erp:homelab-3', 'erp:homelab-4', 'coord:homelab-5', 'erp:worker-60-14-1',
      // the coordinator's worker that never reported, then the retired one
      'coord:homelab-9', 'coord:homelab-20',
    ]);
    expect(rows.some(r => r.no === 33 || r.no === 44 || r.no === 51)).toBe(false);
  });
  it('reads an ERP worker with the slot it holds', () => {
    expect(by('erp:homelab-1')).toMatchObject({ no: 4, kind: 'healthy', running: true, host: 'homelab', workerId: 'homelab-1', epoch: 3, minutes: 212, budget: 360, version: '0.14.0', source: 'erp' });
    expect(by('erp:homelab-3')).toMatchObject({ kind: 'replacing', replacingTo: '0.14.0', now: { city: 'houston', cityName: 'Houston, TX', item: 'server_ram', home: true } });
    expect(by('erp:homelab-4')).toMatchObject({ kind: 'degraded', running: true, state: 'DEGRADED' });
    expect(by('erp:homelab-2')).toMatchObject({ kind: 'parked', running: true, state: 'SESSION_EXPIRED' });
    expect(by('erp:worker-60-14-1').now).toMatchObject({ city: 'philly', home: false });
  });
  it('keeps a silent worker as offline for a week, then drops it', () => {
    const silent = { ...WORKERS[4], worker_id: 'worker-60-14-2', account_no: 33, task: null, last_heartbeat_at: ago(120) };
    const gone = { ...WORKERS[4], worker_id: 'worker-60-14-3', account_no: 40, task: null, last_heartbeat_at: ago(60 * 24 * 8) };
    const more = fleetRows({ ...input, workers: [...WORKERS, silent, gone] }, NOW);
    const row = more.find(r => r.key === 'erp:worker-60-14-2');
    // Slot 33 lapsed and no longer names it: the account is shown, the lease is not.
    expect(row).toMatchObject({ kind: 'offline', running: false, no: 33, host: 'worker-60-14', epoch: null, leaseExpires: null, vncPort: null, now: null });
    expect(more.at(-1)?.key).toBe('erp:worker-60-14-2');
    expect(more.some(r => r.key === 'erp:worker-60-14-3')).toBe(false);
  });
  it('lets the ERP win when both sources know a worker', () => {
    expect(rows.some(r => r.key === 'coord:homelab-1')).toBe(false);
  });
  it('reads a coordinator worker with its pool account, on homelab', () => {
    expect(by('coord:homelab-5')).toMatchObject({
      no: 50, kind: 'healthy', running: true, host: 'homelab', workerId: 'homelab-5', vncPort: 5905, minutes: 120, budget: 360, version: '0.13.18', epoch: null,
      now: { city: 'la', item: 'server_ram', home: true },
    });
    expect(by('coord:homelab-9')).toMatchObject({ no: null, kind: 'offline', running: false, host: 'homelab', heartbeat: null });
  });
  it('counts the legend and the foot', () => {
    expect(fleetRowCounts(rows)).toEqual({ all: 7, healthy: 3, degraded: 1, replacing: 1, parked: 1, offline: 1, retired: 1 });
    expect(fleetRunning(rows)).toEqual({ running: 5, hosts: 2 });
    expect(fleetRowHosts(rows, ['worker-60-14', 'office-mini'])).toEqual(['homelab', 'office-mini', 'worker-60-14']);
  });
  it('keeps a retired coordinator worker out of all, the counts and the hosts', () => {
    expect(by('coord:homelab-20')).toMatchObject({
      kind: 'retired', running: false, retiredAt: '2026-10-22T15:00:00Z', vncPort: null, now: null, host: 'homelab',
    });
    expect(filterFleetRows(rows, { kind: 'all', host: '', q: '' }).some(r => r.kind === 'retired')).toBe(false);
    expect(filterFleetRows(rows, { kind: 'all', host: 'homelab', q: 'homelab-20' })).toEqual([]);
    expect(filterFleetRows(rows, { kind: 'retired', host: '', q: '' }).map(r => r.key)).toEqual(['coord:homelab-20']);
    expect(filterFleetRows(rows, { kind: 'parked', host: '', q: '' }).map(r => r.key)).toEqual(['erp:homelab-2']);
    // Its host is offered only while something live is on it.
    const lone = fleetRows({ ...input, workers: [], slots: [], coordinator: { ...COORDINATOR, workers: [COORDINATOR.workers[3]] } }, NOW);
    expect(fleetRowHosts(lone, [])).toEqual([]);
    expect(fleetRowCounts(lone)).toMatchObject({ all: 0, retired: 1 });
    expect(fleetRunning(lone)).toEqual({ running: 0, hosts: 0 });
  });
  it('offers the Retired chip only while there is a retired worker', () => {
    expect(fleetRowKinds(fleetRowCounts(rows))).toEqual([...FLEET_ROW_KINDS, 'retired']);
    expect(fleetRowKinds(fleetRowCounts(rows.filter(r => r.kind !== 'retired')))).toEqual(FLEET_ROW_KINDS);
  });
  it('filters by kind, host and text', () => {
    expect(filterFleetRows(rows, { kind: 'offline', host: '', q: '' }).map(r => r.key)).toEqual(['coord:homelab-9']);
    expect(filterFleetRows(rows, { kind: 'all', host: 'worker-60-14', q: '' }).map(r => r.key)).toEqual(['erp:worker-60-14-1']);
    expect(filterFleetRows(rows, { kind: 'all', host: '', q: 'houston' }).map(r => r.key)).toEqual(['erp:homelab-3']);
    expect(filterFleetRows(rows, { kind: 'all', host: '', q: 'account 50' }).map(r => r.key)).toEqual(['coord:homelab-5']);
  });
  it('keeps the ERP rows in place when the coordinator answers late', () => {
    const early = fleetRows({ ...input, coordinator: null, challenges: null }, NOW).map(r => r.key);
    const late = rows.map(r => r.key);
    expect(late.filter(k => early.includes(k))).toEqual(early);
    expect(late.filter(k => !early.includes(k))).toEqual(['coord:homelab-5', 'coord:homelab-9', 'coord:homelab-20']);
  });
  it('reads a pool summary row as it reads a snapshot row', () => {
    const summary = POOL.map(a => ({ no: a.no, uid: a.uid, status: a.status, holder: a.holder, note: a.note }));
    expect(fleetRows({ ...input, pool: summary }, NOW).map(r => [r.key, r.kind])).toEqual(rows.map(r => [r.key, r.kind]));
  });
  it('stands without the coordinator and the pool', () => {
    const bare = fleetRows({ slots: SLOTS, workers: WORKERS, release: null, coordinator: null, challenges: null, pool: null }, NOW);
    expect(bare.length).toBe(WORKERS.length);
    expect(bare.find(r => r.key === 'erp:homelab-3')?.kind).toBe('healthy');
  });
});
