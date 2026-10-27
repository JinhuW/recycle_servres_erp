// The ERP fleet: the city task queue the Facebook workers pull from, and the
// slot a worker claims to run one pool account. These are the wire shapes the
// backend answers and the fleet pages, the host agent and the worker consume,
// so field names follow the columns and the worker payloads (snake_case), and
// every instant is an ISO-8601 string.

export const FLEET_TASK_STATES = ['ready', 'leased', 'done', 'cancelled', 'expired'] as const;
export type FleetTaskState = (typeof FLEET_TASK_STATES)[number];

export const FLEET_TASK_KINDS = ['search', 'verify-slug', 'probe'] as const;
export type FleetTaskKind = (typeof FLEET_TASK_KINDS)[number];

/** Why a task exists: the cadence, a city just added, a manager, a round start, a quarantine probe or a slug check. */
export type FleetTaskReason = 'cadence' | 'added' | 'manual' | 'start' | 'probe' | 'verify';

export const FLEET_TASK_EVENT_KINDS = [
  'handed', 'started', 'searched', 'finished', 'stopped', 'released', 'expired', 'done',
] as const;
export type FleetTaskEventKind = (typeof FLEET_TASK_EVENT_KINDS)[number];

/** Worker states that mean the account cannot search: a heartbeat in one of
 *  them releases the worker's current task. DEGRADED is not one of them. */
export const FLEET_PARKED_STATES = ['SESSION_EXPIRED', 'CHECKPOINT', 'CHALLENGE', 'DEAD'] as const;
export type FleetParkedState = (typeof FLEET_PARKED_STATES)[number];

/** `CHALLENGE_*` states all count as parked. */
export const fleetStateParked = (state: string | null | undefined): boolean =>
  !!state && (state.startsWith('CHALLENGE') || (FLEET_PARKED_STATES as readonly string[]).includes(state));

export type FleetCity = {
  slug: string;
  name: string;
  radius_km: number;
  region: string | null;
  enabled: boolean;
  /** Searches per item per day; null follows the default (and tiers later). */
  per_day: number | null;
  verified_at: string | null;
  /** The location label Facebook showed when the slug was verified. */
  verified_as: string | null;
  added_by: string | null;
  added_at: string;
  disabled_at: string | null;
};

/** A city as the Cities tab lists it: the row plus the queue's view of it. */
export type FleetCityListed = FleetCity & {
  /** The open (ready or leased) tasks on this city, at most one per item and kind. */
  open_tasks: FleetTask[];
  /** When each item's last search of this city finished, by item name. */
  last_done_at: Record<string, string>;
};

export type FleetItem = {
  name: string;
  phrases: string[];
  filters: Record<string, unknown>;
  enabled: boolean;
};

export type FleetTaskResult = {
  cards?: number;
  opened?: number;
  reviewed?: number;
  alerted?: number;
  seconds?: number;
  stopped?: boolean;
  [key: string]: unknown;
};

export type FleetTask = {
  id: number;
  city: string;
  item: string;
  kind: FleetTaskKind;
  due_at: string;
  /** Higher first; a manager's task is 100. */
  priority: number;
  state: FleetTaskState;
  worker_id: string | null;
  account_no: number | null;
  epoch: number | null;
  leased_at: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  done_at: string | null;
  reason: FleetTaskReason | null;
  result: FleetTaskResult | null;
};

export type FleetTaskEvent = {
  id: number;
  task_id: number | null;
  worker_id: string | null;
  kind: FleetTaskEventKind;
  detail: Record<string, unknown> | null;
  at: string;
};

/** A task with its events, as the city log shows it. */
export type FleetTaskLog = FleetTask & { events: FleetTaskEvent[] };

/** What a round start did: tasks pulled forward to now, and the ones left
 *  alone because their city-item finished within `start_fresh_hours`. */
export type RoundStartAnswer = { started: number; skipped: number };

/** Device fields a worker leaves to its browser instead of pinning them. */
export type FleetNativeField = 'user_agent' | 'locale' | 'timezone';

/** The browser profile a slot keeps so an account always looks like one machine. */
export type FleetDevice = {
  user_agent: string;
  viewport: [number, number];
  timezone: string;
  locale: string;
  /** `[w, h]`; the worker defaults it to the viewport. */
  screen?: [number, number];
  device_scale_factor?: number;
  /** Filled in by the claim all the same; the worker ignores what is listed. */
  native?: FleetNativeField[];
};

/** A device as a slot stores it: the claim fills in what is missing, so a
 *  profile that leaves the user agent to the browser simply has none. */
export type FleetDeviceProfile = Omit<FleetDevice, 'user_agent'> & { user_agent?: string };

/** Common desktop screens that fit the worker's 1920x1080 X display, with the
 *  scale factor each usually comes with: the coordinator's identity generator
 *  (rs_coordinator/device_profiles.py), so ERP-made devices look like the
 *  homelab's. */
export const FLEET_SCREENS: readonly (readonly [number, number, number])[] = [
  [1920, 1080, 1], [1536, 864, 1.25], [1440, 900, 1], [1366, 768, 1], [1600, 900, 1], [1280, 800, 1],
];
/** Height a maximised browser's toolbars and the taskbar take off the screen. */
export const FLEET_BROWSER_CHROME_HEIGHTS: readonly number[] = [111, 123, 133];

/** FNV-1a, 32 bit: the same number in the browser and in Node, no crypto needed. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The device a slot made in the ERP gets, fixed by its account number so a
 * re-made slot is the same machine again. The user agent is the browser's own
 * (`native`), as the homelab browsers do: a made-up one disagrees with the
 * client hints Chromium still sends. The viewport is the screen less the
 * browser's chrome; the clock is the proxy's.
 */
export function fleetDeviceFor(accountNo: number, timezone: string): FleetDeviceProfile {
  const seed = fnv1a(`fleet-device:${accountNo}`);
  const [w, h, scale] = FLEET_SCREENS[seed % FLEET_SCREENS.length];
  const chrome = FLEET_BROWSER_CHROME_HEIGHTS[Math.floor(seed / FLEET_SCREENS.length) % FLEET_BROWSER_CHROME_HEIGHTS.length];
  return {
    viewport: [w, h - chrome],
    screen: [w, h],
    device_scale_factor: scale,
    timezone,
    locale: 'en-US',
    native: ['user_agent'],
  };
}

// ─── Proxies ──────────────────────────────────────────────────────────────────

export const FLEET_PROXY_SCHEMES = ['http', 'https', 'socks5'] as const;

/** What a pasted proxy URL says, the login reduced to whether there is one. */
export type ParsedProxyUrl = { scheme: (typeof FLEET_PROXY_SCHEMES)[number]; host: string; port: number; has_login: boolean };

/**
 * `scheme://user:pass@host:port`, or why not: the page checks as the manager
 * types and the API again on write. The port is required, since a proxy
 * vendor's endpoints differ only by it. Never echo the input back: it holds
 * the login.
 */
export function parseProxyUrl(raw: string): ParsedProxyUrl | { error: string } {
  const text = raw.trim();
  if (!text) return { error: 'url is required' };
  if (text.length > 500) return { error: 'url is longer than 500 characters' };
  if (/\s/.test(text)) return { error: 'url has a space in it' };
  // A regex, not URL: this module runs where no URL global is typed, and the
  // shape is narrow. A login with `@`, `:` or `/` in it is percent-encoded.
  const m = /^([a-z0-9]+):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/i.exec(text);
  if (!m) return { error: 'url is not scheme://user:pass@host:port' };
  const [, rawScheme, user, pass, host, rawPort] = m;
  const scheme = rawScheme.toLowerCase();
  if (!(FLEET_PROXY_SCHEMES as readonly string[]).includes(scheme)) return { error: `url scheme must be ${FLEET_PROXY_SCHEMES.join(', ')}` };
  const port = Number(rawPort ?? NaN);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'url needs a port, like host:10001' };
  if (Boolean(user) !== Boolean(pass)) return { error: 'url login needs both user and password' };
  return { scheme: scheme as ParsedProxyUrl['scheme'], host: host.toLowerCase(), port, has_login: Boolean(user) };
}

/** An IANA zone such as America/New_York (or UTC) that this runtime knows. */
export function isFleetTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !/^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2})$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A slot on a proxy, as the proxy list names it. */
export type FleetProxyUse = {
  account_no: number;
  pool_status: string;
  parked: boolean;
  /** A worker holds it, or a reservation for one does. */
  leased: boolean;
};

/** A proxy as the manager reads it: never the URL, never the login. */
export type FleetProxy = {
  id: number;
  label: string;
  host: string;
  port: number;
  timezone: string;
  note: string;
  created_at: string;
  slots: FleetProxyUse[];
};

export type FleetProxyWrite = { label: string; url: string; timezone: string; note?: string };
/** `url` absent keeps the stored one. */
export type FleetProxyPatch = { label?: string; url?: string; timezone?: string; note?: string };

/** `POST /api/fleet/slots`: puts a pool account into the fleet. */
export type FleetSlotWrite = { account_no: number; proxy_id: number; home_cities?: string[] };

/** Slots on a proxy that count against `max_accounts_per_proxy`: every one but the parked. */
export const proxyLoad = (p: Pick<FleetProxy, 'slots'>): number => p.slots.filter((s) => !s.parked).length;

// ─── Proxy health ─────────────────────────────────────────────────────────────

/** Answered, but slower than a Marketplace page load tolerates. */
export const FLEET_PROXY_SLOW_MS = 3000;
/** One round every five minutes; the history strip is half-hour buckets over a day. */
export const FLEET_PROXY_ROUND_MS = 5 * 60_000;
export const FLEET_PROXY_BUCKET_MS = 30 * 60_000;
export const FLEET_PROXY_BUCKETS = 48;

/** Degraded: answered slower than FLEET_PROXY_SLOW_MS, or missed one check after answering. */
export type FleetProxyHealthState = 'up' | 'degraded' | 'down' | 'unchecked';
/** ERP: a proxy on the ERP's list. Coordinator: a port a homelab worker dials. */
export type FleetProxySource = 'erp' | 'coordinator';

/** One probe through a proxy. Never carries the login. */
export type FleetProxyCheck = {
  at: string;
  ok: boolean;
  latency_ms: number | null;
  exit_ip: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  org: string | null;
  error: string | null;
};

export type FleetProxyHealth = {
  /** `scheme://host:port`, the login cut out, as fb_worker_accounts names it. */
  exit: string;
  source: FleetProxySource;
  /** The ERP list's id and label; null for a coordinator port. */
  proxy_id: number | null;
  label: string | null;
  host: string;
  port: number;
  /** The ERP slots on it, and the homelab workers dialing it. */
  slots: FleetProxyUse[];
  workers: string[];
  state: FleetProxyHealthState;
  last: FleetProxyCheck | null;
  /** The exit IP before the last one, when it changed in the last 24 h. */
  previous_ip: string | null;
  /** Share of the last 24 h's checks that answered, null with none. */
  uptime: number | null;
  checks: number;
  /** Oldest first, FLEET_PROXY_BUCKETS of them ending now: each bucket's worst state, null with no check. */
  buckets: (Exclude<FleetProxyHealthState, 'unchecked'> | null)[];
};

export type FleetProxyHealthAnswer = {
  proxies: FleetProxyHealth[];
  /** When the last full round ran, and what the console said for the coordinator's ports. */
  round_at: string | null;
  coordinator: 'ok' | 'not_configured' | 'unsupported' | 'unreachable' | null;
};

/** Newest check first. Down is two misses in a row (or a miss with nothing before it), so one blip is degraded, not dead. */
export function proxyHealthState(recent: readonly Pick<FleetProxyCheck, 'ok' | 'latency_ms'>[]): FleetProxyHealthState {
  const [last, before] = recent;
  if (!last) return 'unchecked';
  if (!last.ok) return before && before.ok ? 'degraded' : 'down';
  return (last.latency_ms ?? 0) >= FLEET_PROXY_SLOW_MS ? 'degraded' : 'up';
}

/** A pool account as the fleet runs it. Secrets never travel here: the
 *  proxy is sealed in the row and only the claim answer carries it in clear. */
export type FleetSlot = {
  account_no: number;
  worker_id: string | null;
  host_id: string | null;
  last_host_id: string | null;
  epoch: number;
  lease_expires_at: string | null;
  /** Whether a proxy is set; the URL itself stays sealed. */
  has_proxy: boolean;
  /** The listed proxy it was made on; null for a seeded slot or a removed proxy. */
  proxy_id: number | null;
  device: FleetDeviceProfile | null;
  home_cities: string[];
  quarantined_until: string | null;
  note: string;
  /** A manager parked it: nothing claims it until it is unparked, and its
   *  worker is fenced out. Stored as an infinite lease with no worker. */
  parked: boolean;
  /** Held for its stopped worker's replacement until this instant (a host's
   *  `stopped` with `restart`); null when not reserved. Not a park: it lapses. */
  reserved_until: string | null;
};

/** Which of a pool account's secrets are stored. Never a value. */
export type FleetSecretKind = 'password' | 'totp' | 'email_password' | 'cookie' | 'token';
export const FLEET_SECRET_KINDS: readonly FleetSecretKind[] = ['password', 'totp', 'email_password', 'cookie', 'token'];

/** A task event with the task it belongs to, for a worker's history. */
export type FleetWorkerEvent = FleetTaskEvent & {
  city: string;
  city_name: string | null;
  item: string;
  task_kind: FleetTaskKind;
};

/**
 * `GET /api/fleet/workers/:id`: one worker and what its page shows, in one
 * read. The slot is the one the worker holds, else its account's last one;
 * `holds_slot` says which. No secret value and no proxy URL travel here.
 */
export type FleetWorkerDetail = {
  worker: FleetWorker & { task: (FleetTask & { city_name: string | null }) | null };
  slot: (FleetSlot & { uid: string | null; pool_status: string; minutes_today: number; budget_minutes: number }) | null;
  holds_slot: boolean;
  proxy: { id: number; label: string; host: string; port: number; timezone: string } | null;
  account: {
    no: number;
    uid: string | null;
    email: string | null;
    status: string;
    holder: string | null;
    cookie_at: string | null;
    secrets: FleetSecretKind[];
  } | null;
  /** Its home cities, then the other cities it searched in the window, each
   *  with its last finished search by this worker. */
  cities: { slug: string; name: string | null; radius_km: number | null; home: boolean; last_done_at: string | null; alerts: number }[];
  /** Over the last `days` days, by this worker. `errors` counts tasks it stopped. */
  stats: { days: number; searches: number; alerts: number; errors: number; last_search_at: string | null };
  /** Its tasks of the last 24 hours with their events, newest first. */
  log: FleetTaskLog[];
  /** Its finished, stopped, released and expired task events of the window, newest first. */
  events: FleetWorkerEvent[];
  /** The version the latest release rolls the fleet onto, if a release exists. */
  release_version: string | null;
};

export type FleetHost = {
  host_id: string;
  capacity: number;
  /** False means observe only: the agent reports but starts nothing. */
  authoritative: boolean;
  version: string | null;
  last_seen_at: string | null;
  report: FleetHostReport | null;
  created_at: string;
};

export type FleetHostContainer = {
  worker_id: string;
  image: string;
  state: string;
  started_at: string | null;
  /** Why the agent leaves it stopped until a person acts (§6). */
  hold?: 'operator_needed' | 'crash_limit' | 'operator_stopped' | string;
  exit_code?: number | null;
  image_id?: string;
};

/** What the host agent last posted to `/api/fleet/hosts/:id/report`. */
export type FleetHostReport = {
  version: string;
  containers: FleetHostContainer[];
  /** The agent process that sent it; `conflict` names other agent containers it saw for the host. */
  agent?: { instance_id: string; daemon_id: string | null; conflict?: string[] };
};

/** A roll of one worker image through the fleet, one idle worker at a time.
 *  Kept in `fleet_settings` under `release`; only the latest one is held. */
export type FleetRelease = {
  image: string;
  version: string;
  state: 'rolling' | 'done' | 'failed' | 'superseded';
  started_at: string;
  finished_at: string | null;
  /** Workers already on `image` through this roll, and the ones left out
   *  because their host is observe-only or silent. */
  upgraded: string[];
  skipped: string[];
  /** Why each skipped worker was left out: an observe-only or silent host, a
   *  container that is not running, a worker parked on its account. */
  skip_reasons?: Record<string, string>;
  /** The worker being replaced now, and the state it was in before. */
  current: { worker_id: string; host_id: string; started_at: string; pre_state: string; epoch?: number; stopped_at?: string } | null;
  failure: string | null;
};

export type FleetWorker = {
  worker_id: string;
  host_id: string | null;
  account_no: number | null;
  epoch: number | null;
  /** HEALTHY, SESSION_EXPIRED, CHECKPOINT, CHALLENGE_*, DEGRADED, DEAD. */
  state: string | null;
  version: string | null;
  last_heartbeat_at: string | null;
  vnc_port: number | null;
  detail: Record<string, unknown> | null;
  /** A manager's re-login, in the manager's views only (the worker never reads it). */
  relogin?: FleetWorkerRelogin | null;
};

/** The latest re-login a manager queued for a worker. `delivered_at` is null
 *  until a heartbeat hands the `relogin` directive over, which it does once. */
export type FleetWorkerRelogin = {
  id: string;
  requested_at: string;
  requested_by: string | null;
  delivered_at: string | null;
};

/** The search parameters handed to every worker; keys follow the monitor's config. */
export type FleetSearchSettings = Record<string, unknown>;

export type FleetSettings = {
  per_day_default: number;
  budget_minutes: number;
  lease_minutes: number;
  task_max_minutes: number;
  poll_hold_seconds: number;
  familiar_days: number;
  start_fresh_hours: number;
  quarantine_hours: number;
  quarantine_probe_hours: number;
  /** Days finished tasks are kept; never fewer than familiar_days. */
  retention_days: number;
  /** Non-parked slots one proxy may carry: a static ISP exit is one IP. */
  max_accounts_per_proxy: number;
  search: FleetSearchSettings;
};

export const FLEET_SETTINGS_DEFAULTS: Omit<FleetSettings, 'search'> = {
  per_day_default: 1,
  budget_minutes: 360,
  lease_minutes: 30,
  task_max_minutes: 45,
  poll_hold_seconds: 50,
  familiar_days: 7,
  start_fresh_hours: 2,
  quarantine_hours: 48,
  quarantine_probe_hours: 6,
  retention_days: 90,
  max_accounts_per_proxy: 2,
};

/** What a worker token says about its bearer. `exp` is Unix seconds. The
 *  token itself is `base64url(json) . base64url(hmac-sha256)`; the worker
 *  treats it as opaque. */
export type FleetWorkerTokenClaims = {
  worker_id: string;
  account_no: number;
  epoch: number;
  exp: number;
};

/** A Playwright storage-state cookie, as the monitor restores it. */
export type FleetCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  partitionKey?: string;
};

/** Playwright owns the IndexedDB record format; keep its JSON intact. */
export type FleetStorageState = {
  cookies: FleetCookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
    indexedDB?: Array<Record<string, unknown>>;
  }>;
};

export type ClaimRequest = {
  host_id: string;
  worker_id: string;
  version: string;
  vnc_port: number | null;
  claim_id?: string;
  handoff_epoch?: number;
};

/** The one answer that carries secrets in clear, over HTTPS to the worker that claimed the slot. */
export type ClaimAnswer = {
  worker_token: string;
  epoch: number;
  account: {
    no: number;
    uid: string;
    password: string;
    totp_secret: string;
    cookies: FleetCookie[];
    storage_state?: FleetStorageState;
    token: string | null;
  };
  proxy: { url: string } | null;
  device: FleetDevice;
  home_cities: string[];
  items: FleetItem[];
  settings: {
    search: FleetSearchSettings;
    /** Null when no coordinator is configured: the worker then posts listings nowhere. */
    coordinator_url: string | null;
    lease_minutes: number;
    poll_hold_seconds: number;
  };
  /** The env every fleet worker shares (LLM key, Telegram, ...), added at the
   *  Cloudflare edge from its `FLEET_WORKER_ENV` secret; the backend never
   *  sends it, and it is absent when the secret is unset. */
  env?: Record<string, string>;
};

export type HeartbeatRequest = {
  state: string;
  version: string;
  vnc_port: number | null;
  last_search_at: string | null;
  detail?: Record<string, unknown>;
};

/** A worker's progress on a task, as the city log shows it. */
export type FleetEventRequest = {
  task_id: number;
  kind: 'started' | 'searched' | 'finished' | 'stopped';
  detail?: Record<string, unknown>;
};

/** The worker's current browser session, resealed into the pool row. */
export type SessionRequest = {
  /** Must name this account's session (`c_user` = the account uid, plus `xs`);
   *  an empty list is refused unless `clear` is true. */
  cookies: FleetCookie[];
  /** Complete state; older cookie-only uploads keep the stored origins. */
  storage_state?: FleetStorageState;
  /** Absent keeps the stored token; null clears it. */
  token?: string | null;
  clear?: boolean;
};

export type HostReportRequest = FleetHostReport;

export type HeartbeatAnswer = {
  ok: true;
  /** `relogin` once, on the heartbeat after a manager queued one; else empty. */
  directives: Array<'relogin'>;
  /** The id of the re-login a `relogin` directive delivers. */
  relogin_id?: string;
  worker_token?: string;
  token_expires_at?: number;
};

/** Why a task went to this account, as the worker logs it. */
export type FleetTaskWhy = 'home' | 'familiar' | 'other' | 'manual' | 'probe';

export type HandedTask = {
  id: number;
  kind: FleetTaskKind;
  city: { slug: string; name: string; radius_km: number };
  item: string;
  lease_expires_at: string;
  why: FleetTaskWhy;
};

export type NextTaskRequest = {
  done: { task_id: number; result: FleetTaskResult } | null;
  /** Longest the worker will hold the poll, seconds. */
  wait: number;
  /**
   * `false` closes `done` and leases nothing: a stopping worker reports its
   * last task without being handed one it would leave leased. Default `true`.
   */
  take?: boolean;
};

export type NextTaskAnswer =
  | { task: HandedTask }
  | { task: null; retry_after: number; reason: 'nothing_due' | 'budget' | 'quarantined' | 'draining' }
  /** The answer to `take: false`: `done` is closed, nothing was leased, nothing was held. */
  | { task: null; reason: 'done_only' };

/** `POST /hosts/:id/tickets`: a single-use bearer for one worker container's claim. */
export type ClaimTicketAnswer = { ticket: string; expires_at: string };

export type DesiredAnswer = {
  authoritative: boolean;
  count: number;
  image: string;
  version: string;
  vnc_ports: Record<string, number>;
  leases?: Record<string, { account_no: number; epoch: number }>;
  /** At most one worker the agent should stop and recreate on `image`. */
  roll: { replace: string } | null;
};

export type FleetErrorCode =
  | 'stale_epoch' | 'no_slot' | 'not_found' | 'bad_request' | 'unauthorized'
  /** 503: the ERP itself is missing a key (FLEET_WORKER_TOKEN_KEY, FB_POOL_KEY).
   *  Says nothing about the caller's token; retry later. */
  | 'unavailable'
  /** The city, item or task already exists (or is already leased). */
  | 'exists'
  /** Enabling a city whose slug no worker has verified yet; `override_verify` gets past it. */
  | 'unverified'
  /** Adding to the fleet: the pool account is held, or lacks a password or 2FA key. */
  | 'account_busy' | 'no_login'
  /** The proxy already carries `max_accounts_per_proxy` non-parked slots. */
  | 'proxy_full'
  /** Removing a proxy a non-parked slot uses. */
  | 'in_use'
  /** Removing a slot a worker holds (or a reservation does): park it first. */
  | 'leased'
  /** Re-login for a worker that holds no slot right now. */
  | 'not_running';

export type FleetError = { error: FleetErrorCode; detail?: string };
