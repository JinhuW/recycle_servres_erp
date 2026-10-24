import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every fetcher goes through lib/api.ts (cookies, CSRF header, refresh), so the
// test swaps that module and reads back the method, path and body each one
// sends. The routes are the contract the backend implements.
const calls: { method: string; path: string; body?: unknown }[] = [];
vi.mock('./api', () => {
  const record = (method: string) => (path: string, body?: unknown) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    return Promise.resolve(ANSWERS[path] ?? {});
  };
  return { api: { get: record('GET'), post: record('POST'), put: record('PUT'), delete: record('DELETE') } };
});

const ANSWERS: Record<string, unknown> = {
  '/api/fleet/cities': { cities: [{ slug: 'houston' }] },
  '/api/fleet/items': { items: [{ name: 'server_ram' }] },
  '/api/fleet/tasks?state=ready&item=server_ram': { tasks: [{ id: 1 }] },
  '/api/fleet/city-log?city=houston&hours=24': { tasks: [{ id: 2, events: [] }] },
  '/api/fleet/hosts': { hosts: [{ host_id: 'homelab' }] },
  '/api/fleet/slots': { slots: [{ account_no: 4 }] },
  '/api/fleet/workers': { workers: [{ worker_id: 'homelab-1' }] },
};

const { fleetApi, fleetVncSocketUrl } = await import('./fleet');

beforeEach(() => { calls.length = 0; });

describe('fleetApi', () => {
  it('reads the lists and unwraps their envelopes', async () => {
    expect(await fleetApi.cities()).toEqual([{ slug: 'houston' }]);
    expect(await fleetApi.items()).toEqual([{ name: 'server_ram' }]);
    expect(await fleetApi.hosts()).toEqual([{ host_id: 'homelab' }]);
    expect(await fleetApi.slots()).toEqual([{ account_no: 4 }]);
    expect(await fleetApi.workers()).toEqual([{ worker_id: 'homelab-1' }]);
    expect(calls.map(c => c.path)).toEqual([
      '/api/fleet/cities', '/api/fleet/items', '/api/fleet/hosts', '/api/fleet/slots', '/api/fleet/workers',
    ]);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  it('writes a city through the catalog routes', async () => {
    await fleetApi.addCity({ slug: 'fort-myers', name: 'Fort Myers, FL', radius_km: 300, region: 'south' });
    await fleetApi.updateCity('fort myers', { enabled: true, override_verify: true });
    await fleetApi.updateCity('fort-myers', { per_day: null, pinned: true });
    await fleetApi.removeCity('fort-myers');
    expect(calls).toEqual([
      { method: 'POST', path: '/api/fleet/cities', body: { slug: 'fort-myers', name: 'Fort Myers, FL', radius_km: 300, region: 'south' } },
      { method: 'PUT', path: '/api/fleet/cities/fort%20myers', body: { enabled: true, override_verify: true } },
      { method: 'PUT', path: '/api/fleet/cities/fort-myers', body: { per_day: null, pinned: true } },
      { method: 'DELETE', path: '/api/fleet/cities/fort-myers' },
    ]);
  });

  it('queues a manual task and starts the round', async () => {
    await fleetApi.searchNow('houston', 'server_ram');
    await fleetApi.startRound();
    expect(calls).toEqual([
      { method: 'POST', path: '/api/fleet/tasks', body: { city: 'houston', item: 'server_ram' } },
      { method: 'POST', path: '/api/fleet/round/start', body: {} },
    ]);
  });

  it('builds the task and log queries from the filters it is given', async () => {
    expect(await fleetApi.tasks({ state: 'ready', item: 'server_ram', city: '', worker: undefined })).toEqual([{ id: 1 }]);
    expect(await fleetApi.cityLog({ city: 'houston' })).toEqual([{ id: 2, events: [] }]);
    await fleetApi.cityLog({ worker: 'homelab-1', hours: 6 });
    await fleetApi.tasks();
    expect(calls.map(c => c.path)).toEqual([
      '/api/fleet/tasks?state=ready&item=server_ram',
      '/api/fleet/city-log?city=houston&hours=24',
      '/api/fleet/city-log?worker=homelab-1&hours=6',
      '/api/fleet/tasks',
    ]);
  });

  it('registers, sets, releases and removes hosts', async () => {
    await fleetApi.addHost('worker-60-14');
    await fleetApi.updateHost('worker-60-14', { capacity: 3 });
    await fleetApi.updateHost('worker-60-14', { authoritative: true });
    await fleetApi.release({ image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', version: '0.14.0' });
    await fleetApi.removeHost('worker-60-14');
    expect(calls).toEqual([
      { method: 'POST', path: '/api/fleet/hosts', body: { host_id: 'worker-60-14' } },
      { method: 'PUT', path: '/api/fleet/hosts/worker-60-14', body: { capacity: 3 } },
      { method: 'PUT', path: '/api/fleet/hosts/worker-60-14', body: { authoritative: true } },
      { method: 'POST', path: '/api/fleet/releases', body: { image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', version: '0.14.0' } },
      { method: 'DELETE', path: '/api/fleet/hosts/worker-60-14' },
    ]);
  });

  it('acts on a slot by its account number', async () => {
    await fleetApi.releaseQuarantine(19);
    await fleetApi.parkSlot(12);
    expect(calls).toEqual([
      { method: 'POST', path: '/api/fleet/slots/19/release-quarantine', body: {} },
      { method: 'POST', path: '/api/fleet/slots/12/park', body: {} },
    ]);
  });

  it('reads and writes items and settings', async () => {
    await fleetApi.settings();
    await fleetApi.saveSettings({ start_fresh_hours: 3 });
    await fleetApi.saveItems([{ name: 'server_ram', phrases: ['server ram'], filters: {}, enabled: true }]);
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'GET /api/fleet/settings', 'PUT /api/fleet/settings', 'PUT /api/fleet/items',
    ]);
    expect(calls[1].body).toEqual({ start_fresh_hours: 3 });
  });
});

describe('fleetVncSocketUrl', () => {
  it('follows the page’s scheme and host and escapes the worker id', () => {
    expect(fleetVncSocketUrl('homelab-1', { protocol: 'https:', host: 'inventory.recycleservers.com' }))
      .toBe('wss://inventory.recycleservers.com/api/fleet/vnc/homelab-1/ws');
    expect(fleetVncSocketUrl('ne 1/x', { protocol: 'http:', host: 'localhost:5173' }))
      .toBe('ws://localhost:5173/api/fleet/vnc/ne%201%2Fx/ws');
  });
});
