import { beforeEach, describe, expect, it, vi } from 'vitest';

// Every fetcher goes through lib/api.ts (cookies, CSRF header, refresh), so the
// test swaps that module and reads back the method, path and body each one
// sends, and answers what the backend answers: the shapes routes/fleet.ts and
// src/fleet/*.ts return (bare arrays for items, tasks and the city log; a
// bare city for every city write; wrappers for hosts, slots and workers).
const calls: { method: string; path: string; body?: unknown }[] = [];
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  const record = (method: string) => (path: string, body?: unknown) => {
    calls.push(body === undefined ? { method, path } : { method, path, body });
    return Promise.resolve(ANSWERS[`${method} ${path}`] ?? {});
  };
  return { ApiError: actual.ApiError, api: { get: record('GET'), post: record('POST'), put: record('PUT'), delete: record('DELETE') } };
});

const ANSWERS: Record<string, unknown> = {
  'GET /api/fleet/cities': { cities: [{ slug: 'houston' }] },
  'POST /api/fleet/cities': { slug: 'fort-myers', open_tasks: [{ id: 9, kind: 'verify-slug' }] },
  'PUT /api/fleet/cities/fort-myers': { slug: 'fort-myers', pinned: true },
  'DELETE /api/fleet/cities/fort-myers': { slug: 'fort-myers', enabled: false },
  'GET /api/fleet/items': [{ name: 'server_ram' }],
  'PUT /api/fleet/items': [{ name: 'server_ram' }, { name: 'enterprise_ssd' }],
  'GET /api/fleet/tasks?state=ready&item=server_ram': [{ id: 1 }],
  'POST /api/fleet/tasks': { id: 7, priority: 100 },
  'POST /api/fleet/round/start': { started: 12, skipped: 3 },
  'GET /api/fleet/city-log?city=houston&hours=24': [{ id: 2, events: [] }],
  'GET /api/fleet/hosts': { hosts: [{ host_id: 'homelab' }], release: null },
  'POST /api/fleet/hosts': { host: { host_id: 'worker-60-14', token: 'made-up' } },
  'PUT /api/fleet/hosts/worker-60-14': { host: { host_id: 'worker-60-14', capacity: 3 } },
  'POST /api/fleet/releases': { ok: true, release: { version: '0.14.0', state: 'rolling' } },
  'GET /api/fleet/slots': { slots: [{ account_no: 4 }] },
  'POST /api/fleet/slots/12/park': { slot: { account_no: 12, parked: true } },
  'POST /api/fleet/slots/12/unpark': { slot: { account_no: 12, parked: false } },
  'GET /api/fleet/workers': { workers: [{ worker_id: 'homelab-1' }] },
};

const { ApiError } = await import('./api');
const { fleetApi, fleetErrorCode, fleetVncSocketUrl } = await import('./fleet');

beforeEach(() => { calls.length = 0; });

describe('fleetApi', () => {
  it('reads the lists, unwrapping only the answers that are wrapped', async () => {
    expect(await fleetApi.cities()).toEqual([{ slug: 'houston' }]);
    expect(await fleetApi.items()).toEqual([{ name: 'server_ram' }]);
    expect(await fleetApi.hosts()).toEqual({ hosts: [{ host_id: 'homelab' }], release: null });
    expect(await fleetApi.slots()).toEqual([{ account_no: 4 }]);
    expect(await fleetApi.workers()).toEqual([{ worker_id: 'homelab-1' }]);
    expect(calls.map(c => c.path)).toEqual([
      '/api/fleet/cities', '/api/fleet/items', '/api/fleet/hosts', '/api/fleet/slots', '/api/fleet/workers',
    ]);
    expect(calls.every(c => c.method === 'GET')).toBe(true);
  });

  it('writes a city through the catalog routes and reads the city back bare', async () => {
    expect(await fleetApi.addCity({ slug: 'fort-myers', name: 'Fort Myers, FL', radius_km: 300, region: 'south' }))
      .toEqual({ slug: 'fort-myers', open_tasks: [{ id: 9, kind: 'verify-slug' }] });
    await fleetApi.updateCity('fort myers', { enabled: true, override_verify: true });
    expect(await fleetApi.updateCity('fort-myers', { per_day: null, pinned: true })).toEqual({ slug: 'fort-myers', pinned: true });
    expect(await fleetApi.removeCity('fort-myers')).toEqual({ slug: 'fort-myers', enabled: false });
    expect(calls).toEqual([
      { method: 'POST', path: '/api/fleet/cities', body: { slug: 'fort-myers', name: 'Fort Myers, FL', radius_km: 300, region: 'south' } },
      { method: 'PUT', path: '/api/fleet/cities/fort%20myers', body: { enabled: true, override_verify: true } },
      { method: 'PUT', path: '/api/fleet/cities/fort-myers', body: { per_day: null, pinned: true } },
      { method: 'DELETE', path: '/api/fleet/cities/fort-myers' },
    ]);
  });

  it('queues a manual task and starts the round', async () => {
    expect(await fleetApi.searchNow('houston', 'server_ram')).toEqual({ id: 7, priority: 100 });
    expect(await fleetApi.startRound()).toEqual({ started: 12, skipped: 3 });
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
    expect(await fleetApi.addHost('worker-60-14')).toEqual({ host_id: 'worker-60-14', token: 'made-up' });
    expect(await fleetApi.updateHost('worker-60-14', { capacity: 3 })).toEqual({ host_id: 'worker-60-14', capacity: 3 });
    await fleetApi.updateHost('worker-60-14', { authoritative: true });
    expect(await fleetApi.release({ image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', version: '0.14.0' }))
      .toEqual({ version: '0.14.0', state: 'rolling' });
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
    expect(await fleetApi.parkSlot(12)).toEqual({ account_no: 12, parked: true });
    expect(await fleetApi.unparkSlot(12)).toEqual({ account_no: 12, parked: false });
    expect(calls).toEqual([
      { method: 'POST', path: '/api/fleet/slots/19/release-quarantine', body: {} },
      { method: 'POST', path: '/api/fleet/slots/12/park', body: {} },
      { method: 'POST', path: '/api/fleet/slots/12/unpark', body: {} },
    ]);
  });

  it('reads and writes items and settings', async () => {
    await fleetApi.settings();
    await fleetApi.saveSettings({ start_fresh_hours: 3 });
    const item = { name: 'server_ram', phrases: ['server ram'], filters: {}, enabled: true };
    expect(await fleetApi.saveItems([item])).toHaveLength(2);
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([
      'GET /api/fleet/settings', 'PUT /api/fleet/settings', 'PUT /api/fleet/items',
    ]);
    expect(calls[1].body).toEqual({ start_fresh_hours: 3 });
    // The items route takes the list itself, not an envelope.
    expect(calls[2].body).toEqual([item]);
  });
});

describe('fleetErrorCode', () => {
  it('reads the code a fleet refusal carries', () => {
    expect(fleetErrorCode(new ApiError(409, 'x', undefined, { error: 'unverified', detail: 'd' }))).toBe('unverified');
    expect(fleetErrorCode(new ApiError(500, 'x'))).toBeNull();
    expect(fleetErrorCode(new Error('x'))).toBeNull();
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
