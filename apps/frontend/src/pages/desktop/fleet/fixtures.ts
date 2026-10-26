// Made-up fleet rows for the tests and the dev preview, in the shapes the
// backend answers (the shared types, with the slot/host/worker extras the
// manager routes fold in). Nothing here is a real account, host, token or uid.

import type {
  FleetCityListed, FleetRelease, FleetTask as WireTask, FleetTaskLog,
} from '@recycle-erp/shared';
import type { AlertHitRow, FleetAccount, FleetDoc, ReviewStatsDay } from '../../../lib/coordinator';
import type { PoolAccount } from '../../../lib/facebookPool';
import type { FleetHost, FleetItem, FleetProxy, FleetSettings, FleetSlot, FleetTask, FleetWorker } from '../../../lib/fleet';

export const NOW = Date.parse('2026-10-24T18:30:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

export const ITEMS: FleetItem[] = [
  { name: 'server_ram', phrases: ['server ram', 'ddr4 ecc'], filters: { date_listed: 'last 24 hours' }, enabled: true },
  { name: 'enterprise_ssd', phrases: ['enterprise ssd'], filters: {}, enabled: true },
];

export const SETTINGS: FleetSettings = {
  per_day_default: 1, budget_minutes: 360, lease_minutes: 30, task_max_minutes: 45, poll_hold_seconds: 50,
  familiar_days: 7, start_fresh_hours: 2, quarantine_hours: 48, quarantine_probe_hours: 6, retention_days: 90, max_accounts_per_proxy: 2, search: {},
};

// GET /tasks answers bare rows: no city name, ids as numbers.
const task = (id: number, city: string, item: string, state: WireTask['state'], over: Partial<WireTask> = {}): WireTask => ({
  id, city, item, kind: 'search', due_at: ago(60), priority: 0, state, worker_id: null, account_no: null, epoch: null,
  leased_at: null, lease_expires_at: null, started_at: null, done_at: null, reason: 'cadence', result: null, ...over,
});

export const TASKS: WireTask[] = [
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

// GET /cities: each city carries its open tasks (the same rows) and, per
// item, when its last search finished; an item never searched is absent.
const city = (slug: string, name: string, region: string, over: Partial<FleetCityListed> = {}): FleetCityListed => ({
  slug, name, radius_km: 500, region, enabled: true, per_day: null, pinned: false,
  verified_at: ago(60 * 24 * 3), verified_as: name, added_by: null, added_at: ago(60 * 24 * 5), disabled_at: null,
  open_tasks: TASKS.filter(t => t.city === slug && (t.state === 'ready' || t.state === 'leased')),
  last_done_at: {},
  ...over,
});

export const CITIES: FleetCityListed[] = [
  city('houston', 'Houston, TX', 'south', {
    last_done_at: { server_ram: ago(60 * 25), enterprise_ssd: ago(90) },
    pinned: true, per_day: 2,
  }),
  city('denver', 'Denver, CO', 'mountain', {
    last_done_at: { server_ram: ago(60 * 25), enterprise_ssd: ago(60 * 26) },
  }),
  city('nyc', 'New York, NY', 'northeast', {
    last_done_at: { server_ram: ago(240), enterprise_ssd: ago(180) },
  }),
  city('philly', 'Philadelphia, PA', 'northeast', {
    last_done_at: { server_ram: ago(60 * 23), enterprise_ssd: ago(60 * 24) },
  }),
  city('boise', 'Boise, ID', 'mountain', { enabled: false, verified_at: null, verified_as: null, added_at: ago(4) }),
  city('tulsa', 'Tulsa, OK', 'south', {
    enabled: false, disabled_at: ago(30),
    last_done_at: { server_ram: ago(60 * 30), enterprise_ssd: ago(60 * 30) },
  }),
];

export const CITY_LOG: FleetTaskLog[] = [
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

// The latest roll, as GET /hosts answers it beside the hosts.
export const RELEASE: FleetRelease = {
  image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', version: '0.14.0', state: 'rolling', started_at: ago(45), finished_at: null,
  upgraded: ['homelab-1', 'homelab-2', 'worker-60-14-1'], skipped: ['office-mini-1'],
  current: { worker_id: 'homelab-3', host_id: 'homelab', started_at: ago(3), pre_state: 'HEALTHY' }, failure: null,
};

// GET /workers and the slot rows: a worker's task carries its city's name.
const held = (t: WireTask): FleetTask => ({ ...t, city_name: CITIES.find(c => c.slug === t.city)?.name ?? null });

const worker = (id: string, host: string, no: number, epoch: number, over: Partial<FleetWorker> = {}): FleetWorker => ({
  worker_id: id, host_id: host, account_no: no, epoch, state: 'HEALTHY', version: '0.14.0', last_heartbeat_at: ago(1),
  vnc_port: 5901, detail: null, task: null, ...over,
});

export const WORKERS: FleetWorker[] = [
  worker('homelab-1', 'homelab', 4, 3),
  worker('homelab-2', 'homelab', 7, 5, { state: 'SESSION_EXPIRED', last_heartbeat_at: ago(3) }),
  worker('homelab-3', 'homelab', 12, 7, { task: held(TASKS[0]), version: '0.13.9' }),
  worker('homelab-4', 'homelab', 19, 2, { state: 'DEGRADED', version: '0.13.9' }),
  worker('worker-60-14-1', 'worker-60-14', 31, 2, { task: held(TASKS[7]), vnc_port: 5902 }),
];

const slot = (no: number, over: Partial<FleetSlot> = {}): FleetSlot => ({
  account_no: no, uid: `10000${no}000${no}${no}${no}`, pool_status: 'fleet', worker_id: null, host_id: null, last_host_id: null,
  epoch: 0, lease_expires_at: null, has_proxy: true, proxy_id: null, device: null, home_cities: [], quarantined_until: null, note: '', parked: false, reserved_until: null,
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
  // Parked by a manager: no worker, and the backend answers no lease for it.
  slot(44, { last_host_id: 'homelab', epoch: 9, parked: true, note: 'parked 10-24' }),
];

// The coordinator's stats: one row per UTC day, newest last, with the funnel
// counters a current console sends. Days with nothing reported are absent.
export const STATS: ReviewStatsDay[] = [
  { day: '2026-10-15', reviewed: 1200, alerted: 6, searches: 230, cards: 12000, title_pass: 5500, opened: 2600, keyword_pass: 2400, fresh: 2300, coordinated: 6, sent: 6 },
  { day: '2026-10-22', reviewed: 1250, alerted: 7, searches: 250, cards: 13000, title_pass: 5800, opened: 2800, keyword_pass: 2600, fresh: 2500, coordinated: 7, sent: 7 },
  { day: '2026-10-23', reviewed: 1300, alerted: 8, searches: 240, cards: 13500, title_pass: 6000, opened: 2900, keyword_pass: 2700, fresh: 2600, coordinated: 8, sent: 8 },
  { day: '2026-10-24', reviewed: 1281, alerted: 9, searches: 255, cards: 13865, title_pass: 6181, opened: 2952, keyword_pass: 2719, fresh: 2665, coordinated: 9, sent: 9 },
];

// Alerts sent per (day, item, city) from the coordinator.
export const HITS: AlertHitRow[] = [
  { day: '2026-10-24', priority: 'high', item_name: 'server_ram', search_city: 'houston', sent: 2, hit: 1 },
  { day: '2026-10-22', priority: 'low', item_name: 'enterprise_ssd', search_city: 'houston', sent: 1, hit: 0 },
  { day: '2026-10-23', priority: 'high', item_name: 'server_ram', search_city: 'nyc', sent: 2, hit: 2 },
  { day: '2026-10-23', priority: null, item_name: null, search_city: null, sent: 4, hit: 0 },
];

// The coordinator's workers, as /v1/fleet lists them: one healthy on the
// queue, one that never reported, one whose account the ERP now runs. Only
// the fields the Fleet rows read are filled in.
const coordWorker = (id: string, over: Partial<FleetAccount> = {}): FleetAccount => ({
  worker_id: id, source: 'fleet', region: { key: 'west', name: 'West', scope: 'region' }, cities: [{ slug: 'la', name: 'Los Angeles', radius_km: 500 }],
  session_file: null, proxy_env: null, pacing: { search_interval: null, max_search_interval: null, overridden: false }, vnc_url: 'vnc://10.0.0.1:5905',
  health: {
    worker_id: id, state: 'HEALTHY', status: null, region: 'west', account_id: null, session_expiry: null, session_days_left: 20,
    last_heartbeat_at: ago(1), last_search_at: ago(3), last_listing_at: null, error_count: 0, vnc_url: null, version: '0.13.18',
    liveness: 'live', needs_attention: false,
  },
  account: null, session: null,
  queue: {
    worker_id: id, enrolled: true, capable: true, version: '0.13.18', quarantined: false, minutes_today: 120, budget_minutes: 360,
    handed_today: 4, handed: ['la'], open: [{ item: 'server_ram', city: 'la', leased_at: ago(5) }],
  },
  ...over,
} as FleetAccount);

export const COORDINATOR: FleetDoc = {
  generated_at: ago(0), monitor_worker_id: null, sources: { master: true, fleet: true, monitor: false }, health: { ok: true, error: null },
  versions: { console: '1.0', coordinator: '1.0' }, ai_model: null, search: {}, items: [], regions: [],
  workers: [
    coordWorker('homelab-5'),
    coordWorker('homelab-9', { health: null, queue: null, vnc_url: null }),
    coordWorker('homelab-1'),
  ],
};

// The pool: the accounts the slots hold, one the coordinator's worker holds,
// one a purchaser took, one retired. Made up, like everything here.
const poolAccount = (no: number, status: PoolAccount['status'], holder: string | null = null): PoolAccount => ({
  no, uid: `10000${no}000${no}${no}${no}`, password: '', totp: '', email: `acct${no}@example.test`, emailPassword: '', recovery: '', cookie: '',
  token: '', note: '', status, holder, holderId: null, since: null, addedAt: NOW - 86_400_000 * 30, cookieAt: null, aliveCheckedAt: null, batch: '',
});

export const POOL: PoolAccount[] = [
  poolAccount(4, 'fleet', 'homelab-1'), poolAccount(7, 'fleet', 'homelab-2'), poolAccount(12, 'fleet', 'homelab-3'), poolAccount(19, 'fleet', 'homelab-4'),
  poolAccount(31, 'fleet', 'worker-60-14-1'), poolAccount(33, 'fleet'), poolAccount(35, 'problem'), poolAccount(40, 'fleet'), poolAccount(44, 'fleet'),
  poolAccount(50, 'fleet', 'homelab-5'),
  poolAccount(51, 'taken', 'marcus'),
  poolAccount(52, 'retired'),
];

// GET /proxies: host:port and the slots on each, never the URL.
export const PROXIES: FleetProxy[] = [
  { id: 1, label: 'Decodo NY 1', host: 'isp.example.net', port: 10001, timezone: 'America/New_York', note: 'pair A', created_at: ago(60 * 24),
    slots: [{ account_no: 31, pool_status: 'fleet', parked: false, leased: true }, { account_no: 40, pool_status: 'fleet', parked: false, leased: false }] },
  { id: 2, label: 'Decodo NY 2', host: 'isp.example.net', port: 10002, timezone: 'America/New_York', note: '', created_at: ago(60 * 24),
    slots: [{ account_no: 44, pool_status: 'fleet', parked: true, leased: false }] },
  { id: 3, label: 'Decodo CHI 1', host: 'isp.example.net', port: 10003, timezone: 'America/Chicago', note: '', created_at: ago(60), slots: [] },
];
