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
  pinned: boolean;
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

/** The browser profile a slot keeps so an account always looks like one machine. */
export type FleetDevice = {
  user_agent: string;
  viewport: [number, number];
  timezone: string;
  locale: string;
};

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
  device: FleetDevice | null;
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
  /** Absent keeps the stored token; null clears it. */
  token?: string | null;
  clear?: boolean;
};

export type HostReportRequest = FleetHostReport;

export type HeartbeatAnswer = {
  ok: true;
  directives: Array<'relogin'>;
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
  | 'unverified';

export type FleetError = { error: FleetErrorCode; detail?: string };
