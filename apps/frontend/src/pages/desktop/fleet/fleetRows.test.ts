import { describe, expect, it } from 'vitest';
import { COORDINATOR, NOW, POOL, RELEASE, SLOTS, WORKERS } from './fixtures';
import { FLEET_ROW_KINDS, filterFleetRows, fleetRowCounts, fleetRowHosts, fleetRows, fleetRunning, releasableRows, sortFleetRows } from './fleetRows';

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
      // the coordinator's worker that never reported; the retired one is not a row
      'coord:homelab-9',
    ]);
    expect(rows.some(r => r.no === 33 || r.no === 44 || r.no === 51)).toBe(false);
  });
  it('reads an ERP worker with the slot it holds', () => {
    expect(by('erp:homelab-1')).toMatchObject({ no: 4, kind: 'healthy', running: true, host: 'homelab', workerId: 'homelab-1', epoch: 3, minutes: 212, budget: 360, version: '0.14.0', source: 'erp' });
    expect(by('erp:homelab-3')).toMatchObject({ kind: 'healthy', replacingTo: '0.14.0', now: { city: 'houston', cityName: 'Houston, TX', item: 'server_ram', home: false } });
    expect(by('erp:homelab-4')).toMatchObject({ kind: 'healthy', running: true, state: 'DEGRADED' });
    expect(by('erp:homelab-2')).toMatchObject({ kind: 'parked', running: true, state: 'SESSION_EXPIRED' });
    expect(by('erp:worker-60-14-1').now).toMatchObject({ city: 'philly', home: false });
  });
  it('reads a worker parked on a page that would not load as resumable, with its error', () => {
    // A slot carries its worker, and the row reads that one.
    const reporting = (state: string, detail: Record<string, unknown>) => fleetRows({
      ...input, slots: SLOTS.map(s => s.account_no === 4 ? { ...s, worker: { ...s.worker!, state, detail } } : s),
    }, NOW).find(r => r.key === 'erp:homelab-1')!;
    expect(reporting('DEAD', { reason: 'connect_failed', operator: true, error: 'Page.goto: Timeout 60000ms exceeded.' }))
      .toMatchObject({ kind: 'parked', running: true, resumable: true, parkError: 'Page.goto: Timeout 60000ms exceeded.', resume: null });
    expect(reporting('DEAD', { reason: 'login_failed' }).resumable).toBe(false);
    expect(by('coord:homelab-5').resumable).toBe(false);
  });
  it('reads a running worker whose slot a manager parked as parked', () => {
    const parkedSlots = SLOTS.map(s => s.account_no === 4 ? { ...s, parked: true } : s);
    const row = fleetRows({ ...input, slots: parkedSlots }, NOW).find(r => r.key === 'erp:homelab-1');
    expect(row).toMatchObject({ kind: 'parked', running: true, state: 'HEALTHY' });
  });
  it('keeps a silent worker as parked for a week, then drops it', () => {
    const silent = { ...WORKERS[4], worker_id: 'worker-60-14-2', account_no: 33, task: null, last_heartbeat_at: ago(120) };
    const gone = { ...WORKERS[4], worker_id: 'worker-60-14-3', account_no: 40, task: null, last_heartbeat_at: ago(60 * 24 * 8) };
    const more = fleetRows({ ...input, workers: [...WORKERS, silent, gone] }, NOW);
    const row = more.find(r => r.key === 'erp:worker-60-14-2');
    // Slot 33 lapsed and no longer names it: the account is shown, the lease is not.
    expect(row).toMatchObject({ kind: 'parked', running: false, no: 33, host: 'worker-60-14', epoch: null, leaseExpires: null, vncPort: null, now: null });
    expect(more.at(-1)?.key).toBe('erp:worker-60-14-2');
    expect(more.some(r => r.key === 'erp:worker-60-14-3')).toBe(false);
  });
  it('reads a silent worker as parked whatever its host reports', () => {
    const silent = { ...WORKERS[0], worker_id: 'homelab-14', account_no: 4, task: null, last_heartbeat_at: ago(280) };
    const row = fleetRows({ ...input, workers: [...WORKERS, silent] }, NOW).find(r => r.workerId === 'homelab-14')!;
    // Account 4 is homelab-1's now: the row names it, but not homelab-1's minutes.
    expect(row).toMatchObject({ kind: 'parked', running: false, no: 4, epoch: null, minutes: null, budget: null });
  });
  it('reads a stopped worker whose account left the fleet as free', () => {
    const silent = (worker_id: string, account_no: number) =>
      ({ ...WORKERS[0], worker_id, account_no, task: null, last_heartbeat_at: ago(30) });
    // Account 70 has no slot (retired).
    const more = fleetRows({ ...input, workers: [...WORKERS, silent('homelab-7', 70)] }, NOW);
    expect(more.find(r => r.workerId === 'homelab-7')).toMatchObject({ kind: 'free', running: false, no: 70, slot: null });
    expect(fleetRowCounts(more)).toMatchObject({ free: 1 });
    expect(fleetRunning(more)).toEqual(fleetRunning(rows));
    // Still reporting, it is free already (its next call is refused) but still counts as running.
    const live = fleetRows({ ...input, workers: [...WORKERS, { ...silent('homelab-7', 70), last_heartbeat_at: ago(0.2) }] }, NOW);
    expect(live.find(r => r.workerId === 'homelab-7')).toMatchObject({ kind: 'free', running: true });
  });
  it('leaves out a free worker once its host no longer reports its container', () => {
    const free = { ...WORKERS[0], worker_id: 'homelab-7', host_id: 'homelab', account_no: 70, task: null, last_heartbeat_at: ago(30) };
    const report = (ids: string[]) => ({ version: '1', containers: ids.map(worker_id => ({ worker_id, image: 'img:1', state: 'exited', started_at: null })) });
    const rowsWith = (hosts: Parameters<typeof fleetRows>[0]['hosts']) =>
      fleetRows({ ...input, workers: [...WORKERS, free], hosts }, NOW).find(r => r.workerId === 'homelab-7');
    expect(rowsWith([{ host_id: 'homelab', report: report(['homelab-1']) }])).toBeUndefined();
    expect(rowsWith([{ host_id: 'homelab', report: report(['homelab-1', 'homelab-7']) }])?.kind).toBe('free');
    // No report yet: unknown is not gone.
    expect(rowsWith([{ host_id: 'homelab', report: null }])?.kind).toBe('free');
  });
  it('reads a stopped worker of a deleted host as parked, not free: no agent starts it', () => {
    const gone = { ...WORKERS[0], worker_id: 'gone-1', host_id: 'gone', account_no: 70, task: null, last_heartbeat_at: ago(30) };
    const more = fleetRows({ ...input, workers: [...WORKERS, gone], hosts: [{ host_id: 'homelab' }] }, NOW);
    expect(more.find(r => r.workerId === 'gone-1')?.kind).toBe('parked');
  });
  it('releases the lost and the manager-parked accounts, once each, and counts the rest', () => {
    const silent = { ...WORKERS[0], worker_id: 'worker-60-14-2', host_id: 'worker-60-14', account_no: 33, task: null, last_heartbeat_at: ago(120) };
    const parked = { ...WORKERS[0], worker_id: 'homelab-8', account_no: 44, state: 'CHECKPOINT', task: null, last_heartbeat_at: ago(120) };
    const more = fleetRows({ ...input, workers: [...WORKERS, silent, parked] }, NOW);
    const { release, skipped } = releasableRows(more);
    // homelab-2 reports SESSION_EXPIRED on its own slot; slot 44 is parked.
    expect(release.map(r => [r.workerId, r.slot?.account_no])).toEqual([['homelab-2', 7], ['homelab-8', 44]]);
    // The silent worker on a good account and the coordinator's homelab-9.
    expect(skipped).toBe(2);
    expect(releasableRows(rows.filter(r => r.kind === 'healthy'))).toEqual({ release: [], skipped: 0 });
  });
  it('lets the ERP win when both sources know a worker', () => {
    expect(rows.some(r => r.key === 'coord:homelab-1')).toBe(false);
  });
  it('reads a coordinator worker with its pool account, on homelab', () => {
    expect(by('coord:homelab-5')).toMatchObject({
      no: 50, kind: 'healthy', running: true, host: 'homelab', workerId: 'homelab-5', vncPort: 5905, minutes: 120, budget: 360, version: '0.13.18', epoch: null,
      now: { city: 'la', item: 'server_ram', home: true },
    });
    expect(by('coord:homelab-9')).toMatchObject({ no: null, kind: 'parked', running: false, host: 'homelab', heartbeat: null });
  });
  it('counts the legend and the foot', () => {
    expect(fleetRowCounts(rows)).toEqual({ all: 7, healthy: 5, free: 0, parked: 2 });
    expect(fleetRunning(rows)).toEqual({ running: 5, hosts: 2 });
    expect(fleetRowHosts(rows, ['worker-60-14', 'office-mini'])).toEqual(['homelab', 'office-mini', 'worker-60-14']);
  });
  it('has three kinds, and no row for a retired coordinator worker', () => {
    expect(FLEET_ROW_KINDS).toEqual(['healthy', 'free', 'parked']);
    expect(rows.some(r => r.workerId === 'homelab-20')).toBe(false);
    expect(filterFleetRows(rows, { kind: 'parked', host: '', q: '' }).map(r => r.key)).toEqual(['erp:homelab-2', 'coord:homelab-9']);
    const lone = fleetRows({ ...input, workers: [], slots: [], coordinator: { ...COORDINATOR, workers: [COORDINATOR.workers[3]] } }, NOW);
    expect(lone).toEqual([]);
    expect(fleetRowHosts(lone, [])).toEqual([]);
  });
  it('sorts by a column, empty cells last either way', () => {
    const ids = (col: Parameters<typeof sortFleetRows>[1], dir: 'asc' | 'desc') => sortFleetRows(rows, col, dir).map(r => r.workerId);
    expect(ids('worker', 'desc')).toEqual(['worker-60-14-1', 'homelab-9', 'homelab-5', 'homelab-4', 'homelab-3', 'homelab-2', 'homelab-1']);
    expect(ids('state', 'asc').slice(-2).sort()).toEqual(['homelab-2', 'homelab-9']);
    // homelab-9 has no account: last whichever way.
    expect(ids('account', 'asc').at(-1)).toBe('homelab-9');
    expect(ids('account', 'desc').at(-1)).toBe('homelab-9');
    const today = sortFleetRows(rows, 'today', 'desc').map(r => r.minutes);
    expect(today.filter(m => m !== null)).toEqual([...today.filter(m => m !== null)].sort((a, b) => b! - a!));
  });
  it('filters by kind, host and text', () => {
    expect(filterFleetRows(rows, { kind: 'healthy', host: 'homelab', q: 'homelab-3' }).map(r => r.key)).toEqual(['erp:homelab-3']);
    expect(filterFleetRows(rows, { kind: 'all', host: 'worker-60-14', q: '' }).map(r => r.key)).toEqual(['erp:worker-60-14-1']);
    expect(filterFleetRows(rows, { kind: 'all', host: '', q: 'houston' }).map(r => r.key)).toEqual(['erp:homelab-3']);
    expect(filterFleetRows(rows, { kind: 'all', host: '', q: 'account 50' }).map(r => r.key)).toEqual(['coord:homelab-5']);
  });
  it('keeps the ERP rows in place when the coordinator answers late', () => {
    const early = fleetRows({ ...input, coordinator: null, challenges: null }, NOW).map(r => r.key);
    const late = rows.map(r => r.key);
    expect(late.filter(k => early.includes(k))).toEqual(early);
    expect(late.filter(k => !early.includes(k))).toEqual(['coord:homelab-5', 'coord:homelab-9']);
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
