// Made-up fleet rows for the tests and the dev preview. Nothing here is a
// real account, host, token or uid.

import type {
  FleetCity, FleetCityLogTask, FleetHost, FleetItem, FleetSettings, FleetSlot, FleetTask, FleetWorker,
} from '../../../lib/fleet';

export const NOW = Date.parse('2026-10-24T18:30:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

export const ITEMS: FleetItem[] = [
  { name: 'server_ram', phrases: ['server ram', 'ddr4 ecc'], filters: { date_listed: 'last-24-hours' }, enabled: true },
  { name: 'enterprise_ssd', phrases: ['enterprise ssd'], filters: {}, enabled: true },
];

export const SETTINGS: FleetSettings = {
  per_day_default: 1, budget_minutes: 360, lease_minutes: 30, task_max_minutes: 45, poll_hold_seconds: 50,
  familiar_days: 7, start_fresh_hours: 2, quarantine_hours: 48, quarantine_probe_hours: 6, search: {},
};

const city = (slug: string, name: string, region: string, over: Partial<FleetCity> = {}): FleetCity => ({
  slug, name, radius_km: 500, region, enabled: true, per_day: null, pinned: false,
  verified_at: ago(60 * 24 * 3), verified_as: name, added_by: null, added_at: ago(60 * 24 * 5), disabled_at: null,
  open: { server_ram: null, enterprise_ssd: null }, last_done_at: { server_ram: null, enterprise_ssd: null },
  ...over,
});

const open = (id: number, state: 'ready' | 'leased', dueMin: number, worker: string | null = null) => ({
  id, kind: 'search' as const, state, due_at: state === 'leased' ? ago(10) : (dueMin < 0 ? ago(-dueMin) : ahead(dueMin)),
  priority: 0, worker_id: worker, lease_expires_at: state === 'leased' ? ahead(20) : null,
});

export const CITIES: FleetCity[] = [
  city('houston', 'Houston, TX', 'south', {
    open: { server_ram: open(201, 'leased', 0, 'homelab-3'), enterprise_ssd: open(202, 'ready', 180) },
    last_done_at: { server_ram: ago(60 * 25), enterprise_ssd: ago(90) },
    pinned: true, per_day: 2,
  }),
  city('denver', 'Denver, CO', 'mountain', {
    open: { server_ram: open(203, 'ready', -45), enterprise_ssd: open(204, 'ready', -40) },
    last_done_at: { server_ram: ago(60 * 25), enterprise_ssd: ago(60 * 26) },
  }),
  city('nyc', 'New York, NY', 'northeast', {
    open: { server_ram: open(205, 'ready', 60 * 20), enterprise_ssd: open(206, 'ready', 60 * 21) },
    last_done_at: { server_ram: ago(240), enterprise_ssd: ago(180) },
  }),
  city('philly', 'Philadelphia, PA', 'northeast', {
    open: { server_ram: open(207, 'ready', 15), enterprise_ssd: open(208, 'leased', 0, 'worker-60-14-1') },
    last_done_at: { server_ram: ago(60 * 23), enterprise_ssd: ago(60 * 24) },
  }),
  city('boise', 'Boise, ID', 'mountain', {
    enabled: false, verified_at: null, verified_as: null, added_at: ago(4),
    open: { server_ram: null, enterprise_ssd: null },
  }),
  city('tulsa', 'Tulsa, OK', 'south', {
    enabled: false, disabled_at: ago(30),
    open: { server_ram: null, enterprise_ssd: null },
    last_done_at: { server_ram: ago(60 * 30), enterprise_ssd: ago(60 * 30) },
  }),
];

const task = (id: number, cityId: string, item: string, state: FleetTask['state'], over: Partial<FleetTask> = {}): FleetTask => ({
  id, city: cityId, city_name: CITIES.find(c => c.slug === cityId)?.name ?? cityId, item, kind: 'search', due_at: ago(60),
  priority: 0, state, worker_id: null, account_no: null, epoch: null, leased_at: null, lease_expires_at: null,
  started_at: null, done_at: null, reason: 'cadence', result: null, ...over,
});

export const TASKS: FleetTask[] = [
  task(201, 'houston', 'server_ram', 'leased', { worker_id: 'homelab-3', account_no: 12, epoch: 7, leased_at: ago(10), lease_expires_at: ahead(20), started_at: ago(9) }),
  task(202, 'houston', 'enterprise_ssd', 'ready', { due_at: ahead(180) }),
  task(203, 'denver', 'server_ram', 'ready', { due_at: ago(45) }),
  task(204, 'denver', 'enterprise_ssd', 'ready', { due_at: ago(40) }),
  task(205, 'nyc', 'server_ram', 'ready', { due_at: ahead(60 * 20) }),
  task(206, 'nyc', 'enterprise_ssd', 'ready', { due_at: ahead(60 * 21) }),
  task(207, 'philly', 'server_ram', 'ready', { due_at: ahead(15) }),
  task(208, 'philly', 'enterprise_ssd', 'leased', { worker_id: 'worker-60-14-1', account_no: 31, epoch: 2, leased_at: ago(4), lease_expires_at: ahead(26) }),
  task(190, 'nyc', 'server_ram', 'done', {
    worker_id: 'homelab-1', account_no: 4, epoch: 3, leased_at: ago(250), lease_expires_at: ago(220), started_at: ago(249), done_at: ago(240),
    result: { cards: 115, opened: 9, reviewed: 9, alerted: 1, seconds: 412 },
  }),
  task(191, 'nyc', 'enterprise_ssd', 'done', {
    worker_id: 'homelab-1', account_no: 4, epoch: 3, leased_at: ago(185), lease_expires_at: ago(155), started_at: ago(184), done_at: ago(180),
    result: { cards: 40, opened: 3, reviewed: 3, alerted: 0, seconds: 290 },
  }),
  task(192, 'houston', 'enterprise_ssd', 'done', {
    worker_id: 'homelab-3', account_no: 12, epoch: 7, leased_at: ago(100), lease_expires_at: ago(70), started_at: ago(99), done_at: ago(90),
    result: { cards: 80, opened: 5, reviewed: 5, alerted: 0, seconds: 500 },
  }),
  task(180, 'tulsa', 'server_ram', 'cancelled', { done_at: ago(30), reason: 'cadence' }),
  task(181, 'tulsa', 'enterprise_ssd', 'cancelled', { done_at: ago(30), reason: 'cadence' }),
  task(209, 'boise', 'server_ram', 'ready', { kind: 'verify-slug', reason: 'verify', due_at: ago(4), priority: 50 }),
  task(170, 'denver', 'server_ram', 'expired', { worker_id: 'homelab-2', leased_at: ago(60 * 5), lease_expires_at: ago(60 * 4), done_at: ago(60 * 4) }),
];

export const CITY_LOG: FleetCityLogTask[] = [
  {
    ...TASKS[8],
    events: [
      { id: 1, task_id: 190, worker_id: 'homelab-1', kind: 'handed', detail: { why: 'home' }, at: ago(250) },
      { id: 2, task_id: 190, worker_id: 'homelab-1', kind: 'started', detail: null, at: ago(249) },
      { id: 3, task_id: 190, worker_id: 'homelab-1', kind: 'searched', detail: { phrase: 'server ram', cards: 60 }, at: ago(246) },
      { id: 4, task_id: 190, worker_id: 'homelab-1', kind: 'searched', detail: { phrase: 'ddr4 ecc', cards: 55 }, at: ago(243) },
      { id: 5, task_id: 190, worker_id: 'homelab-1', kind: 'finished', detail: { seconds: 412 }, at: ago(240) },
      { id: 6, task_id: 190, worker_id: 'homelab-1', kind: 'done', detail: null, at: ago(240) },
    ],
  },
  { ...TASKS[4], events: [] },
];

export const HOSTS: FleetHost[] = [
  {
    host_id: 'homelab', capacity: 4, authoritative: true, version: '1.340.0', last_seen_at: ago(1), created_at: ago(60 * 24 * 2),
    report: {
      version: '1.340.0',
      containers: [
        { worker_id: 'homelab-1', image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', state: 'running', started_at: ago(60 * 20) },
        { worker_id: 'homelab-2', image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', state: 'running', started_at: ago(60 * 20) },
        { worker_id: 'homelab-3', image: 'ghcr.io/jinhuw/aimm-recycle:0.13.9', state: 'running', started_at: ago(60 * 30) },
        { worker_id: 'homelab-4', image: 'ghcr.io/jinhuw/aimm-recycle:0.13.9', state: 'running', started_at: ago(60 * 30) },
      ],
    },
    desired: { count: 4, image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', version: '0.14.0', roll: { replace: 'homelab-3' } },
  },
  {
    host_id: 'worker-60-14', capacity: 2, authoritative: true, version: '1.340.0', last_seen_at: ago(1), created_at: ago(60 * 6),
    report: {
      version: '1.340.0',
      containers: [
        { worker_id: 'worker-60-14-1', image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', state: 'running', started_at: ago(60 * 3) },
      ],
    },
    desired: { count: 2, image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', version: '0.14.0', roll: null },
  },
  {
    host_id: 'office-mini', capacity: 0, authoritative: false, version: null, last_seen_at: null, created_at: ago(5),
    report: null, desired: { count: 0, image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', version: '0.14.0', roll: null },
  },
];

const worker = (id: string, host: string, no: number, epoch: number, over: Partial<FleetWorker> = {}): FleetWorker => ({
  worker_id: id, host_id: host, account_no: no, epoch, state: 'HEALTHY', version: '0.14.0', last_heartbeat_at: ago(1),
  vnc_port: 5901, detail: null, task: null, ...over,
});

export const WORKERS: FleetWorker[] = [
  worker('homelab-1', 'homelab', 4, 3),
  worker('homelab-2', 'homelab', 7, 5, { state: 'SESSION_EXPIRED', last_heartbeat_at: ago(3) }),
  worker('homelab-3', 'homelab', 12, 7, { task: TASKS[0], version: '0.13.9' }),
  worker('homelab-4', 'homelab', 19, 2, { state: 'DEGRADED', version: '0.13.9' }),
  worker('worker-60-14-1', 'worker-60-14', 31, 2, { task: TASKS[7], vnc_port: 5902 }),
];

const slot = (no: number, over: Partial<FleetSlot> = {}): FleetSlot => ({
  account_no: no, uid: `10000${no}000${no}${no}${no}`, pool_status: 'fleet', worker_id: null, host_id: null, last_host_id: null,
  epoch: 0, lease_expires_at: null, has_proxy: true, device: null, home_cities: [], quarantined_until: null, note: '',
  minutes_today: 0, budget_minutes: 360, worker: null,
  ...over,
});

export const SLOTS: FleetSlot[] = [
  slot(4, { worker_id: 'homelab-1', host_id: 'homelab', last_host_id: 'homelab', epoch: 3, lease_expires_at: ahead(28), home_cities: ['nyc', 'philly'], minutes_today: 212, worker: WORKERS[0] }),
  slot(7, { worker_id: 'homelab-2', host_id: 'homelab', last_host_id: 'homelab', epoch: 5, lease_expires_at: ahead(26), minutes_today: 40, worker: WORKERS[1] }),
  slot(12, { worker_id: 'homelab-3', host_id: 'homelab', last_host_id: 'homelab', epoch: 7, lease_expires_at: ahead(29), home_cities: ['houston'], minutes_today: 360, worker: WORKERS[2] }),
  slot(19, { worker_id: 'homelab-4', host_id: 'homelab', last_host_id: 'homelab', epoch: 2, lease_expires_at: ahead(25), quarantined_until: ahead(60 * 30), minutes_today: 15, worker: WORKERS[3] }),
  slot(31, { worker_id: 'worker-60-14-1', host_id: 'worker-60-14', last_host_id: 'worker-60-14', epoch: 2, lease_expires_at: ahead(29), minutes_today: 95, worker: WORKERS[4] }),
  slot(33, { last_host_id: 'homelab', epoch: 4, lease_expires_at: ago(60 * 5) }),
  slot(35, { pool_status: 'problem', last_host_id: 'homelab', epoch: 1, lease_expires_at: ago(60 * 48), note: 'checkpoint 10-20' }),
  slot(40),
];
