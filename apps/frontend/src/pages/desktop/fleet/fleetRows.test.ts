import { describe, expect, it } from 'vitest';
import { COORDINATOR, NOW, POOL, RELEASE, SLOTS, WORKERS } from './fixtures';
import { filterFleetRows, fleetRowCounts, fleetRowHosts, fleetRows, fleetRunning, NOT_RUNNING } from './fleetRows';

const input = { slots: SLOTS, workers: WORKERS, release: RELEASE, coordinator: COORDINATOR, challenges: null, pool: POOL };

describe('fleetRows', () => {
  it('does not duplicate a pool account mentioned by an old coordinator worker', () => {
    const worker = { ...COORDINATOR.workers[0], worker_id: 'retired-worker', session: { ...COORDINATOR.workers[0].session!, fb_user_id: POOL[0].uid } };
    const rows = fleetRows({ ...input, coordinator: { ...COORDINATOR, workers: [worker] } }, NOW);
    expect(rows.some(r => r.key === 'coord:retired-worker')).toBe(false);
  });
  const rows = fleetRows(input, NOW);
  const by = (key: string) => rows.find(r => r.key === key)!;

  it('is one row per account: slots, then the coordinator’s workers, then the rest of the pool', () => {
    expect(rows.map(r => r.key)).toEqual([
      // running, by worker id
      'erp:4', 'erp:7', 'erp:12', 'erp:19', 'coord:homelab-5', 'erp:31',
      // idle, by account number; the coordinator's silent worker has none
      'erp:33', 'erp:35', 'erp:40', 'erp:44', 'pool:51', 'pool:52', 'coord:homelab-9',
    ]);
  });
  it('reads an ERP slot with its worker', () => {
    expect(by('erp:4')).toMatchObject({ no: 4, kind: 'healthy', running: true, host: 'homelab', workerId: 'homelab-1', epoch: 3, minutes: 212, budget: 360, version: '0.14.0', source: 'erp' });
    expect(by('erp:12')).toMatchObject({ kind: 'replacing', replacingTo: '0.14.0', now: { city: 'houston', cityName: 'Houston, TX', item: 'server_ram', home: true } });
    expect(by('erp:19')).toMatchObject({ kind: 'quarantined', running: true, state: 'DEGRADED' });
    expect(by('erp:7')).toMatchObject({ kind: 'parked', running: true, state: 'SESSION_EXPIRED' });
    expect(by('erp:31').now).toMatchObject({ city: 'philly', home: false });
  });
  it('reads an idle slot by why nothing runs it', () => {
    expect(by('erp:33')).toMatchObject({ kind: 'parked', running: false, host: null, lastHost: 'homelab', workerId: null, state: null });
    expect(by('erp:35')).toMatchObject({ kind: 'parked', running: false });
    expect(by('erp:44')).toMatchObject({ kind: 'parked', running: false });
    expect(by('erp:44').slot?.parked).toBe(true);
  });
  it('lets the ERP win when both sources know an account', () => {
    expect(rows.some(r => r.key === 'coord:homelab-1')).toBe(false);
    expect(by('erp:4').source).toBe('erp');
  });
  it('reads a coordinator worker with its pool account, on homelab', () => {
    expect(by('coord:homelab-5')).toMatchObject({
      no: 50, kind: 'healthy', running: true, host: 'homelab', workerId: 'homelab-5', vncPort: 5905, minutes: 120, budget: 360, version: '0.13.18', epoch: null,
      now: { city: 'la', item: 'server_ram', home: true },
    });
    expect(by('coord:homelab-9')).toMatchObject({ no: null, kind: 'parked', running: false, host: null, heartbeat: null });
  });
  it('reads the rest of the pool by status', () => {
    expect(by('pool:51')).toMatchObject({ no: 51, kind: 'taken', running: false, source: 'pool' });
    expect(by('pool:51').pool?.holder).toBe('marcus');
    expect(by('pool:52')).toMatchObject({ kind: 'parked', source: 'pool' });
  });
  it('counts the legend and the foot', () => {
    expect(fleetRowCounts(rows)).toEqual({ all: 13, healthy: 3, degraded: 0, replacing: 1, quarantined: 1, parked: 7, taken: 1 });
    // A quarantined worker runs but is not counted as running, as the legend reads it.
    expect(fleetRunning(rows)).toEqual({ running: 4, hosts: 2 });
    expect(fleetRowHosts(rows, ['worker-60-14', 'office-mini'])).toEqual(['homelab', 'office-mini', 'worker-60-14']);
  });
  it('filters by kind, host and text', () => {
    expect(filterFleetRows(rows, { kind: 'quarantined', host: '', q: '' }).map(r => r.key)).toEqual(['erp:19']);
    expect(filterFleetRows(rows, { kind: 'all', host: 'worker-60-14', q: '' }).map(r => r.key)).toEqual(['erp:31']);
    expect(filterFleetRows(rows, { kind: 'all', host: NOT_RUNNING, q: '' }).length).toBe(7);
    expect(filterFleetRows(rows, { kind: 'all', host: '', q: 'houston' }).map(r => r.key)).toEqual(['erp:12']);
    expect(filterFleetRows(rows, { kind: 'all', host: '', q: 'account 51' }).map(r => r.key)).toEqual(['pool:51']);
  });
  it('stands without the coordinator and the pool', () => {
    const bare = fleetRows({ slots: SLOTS, workers: WORKERS, release: null, coordinator: null, challenges: null, pool: null }, NOW);
    expect(bare.length).toBe(SLOTS.length);
    expect(bare.find(r => r.key === 'erp:12')?.kind).toBe('healthy');
  });
});
