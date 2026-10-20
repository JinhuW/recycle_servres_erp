// Typed client for the Facebook worker control plane (/api/coordinator/*,
// manager-only). The backend forwards these calls to the coordinator API with
// its bearer token; a 501 from any of them means the proxy env vars are unset.

import { api } from './api';

// snake_case on purpose: these rows pass through the proxy verbatim from the
// coordinator's own JSON.

export type WorkerState =
  | 'HEALTHY' | 'DEGRADED' | 'SESSION_EXPIRED'
  | 'CHALLENGE_2FA' | 'CHALLENGE_EMAIL' | 'CHALLENGE_CAPTCHA'
  | 'CHECKPOINT' | 'DEAD';

// Computed by the control plane from the heartbeat it owns — the UI shows it
// rather than re-deriving one from timestamps it sees late. 'unknown' is a
// worker that has never reported: a deployment that never started, which is
// a different problem from one that stopped.
export type WorkerLiveness = 'live' | 'stale' | 'dead' | 'unknown';

export type FleetWorker = {
  worker_id: string;
  state: WorkerState;
  status: string | null;
  region: string | null;
  account_id: string | null;
  session_expiry: string | null;
  session_days_left: number | null;
  last_heartbeat_at: string | null;
  last_search_at: string | null;
  last_listing_at: string | null;
  error_count: number;
  vnc_url: string | null;
  // The build the worker reported ("0.5.6 (d3e9a30)"); null from images
  // that predate build reporting.
  version?: string | null;
  // Re-login progress (see reloginProgress). Absent from a coordinator that
  // predates it, which leaves the Watch page as it was.
  relogin_requested_at?: string | null;
  relogin_last_requested_at?: string | null;
  login_step?: string | null;
  login_step_at?: string | null;
  liveness: WorkerLiveness;
  needs_attention: boolean;
};

export type Challenge = {
  id: number;
  worker_id: string;
  account_id: string | null;
  kind: string;
  status: string;
  vnc_url: string | null;
  // A coordinator-side path (/v1/challenges/<id>/screenshot); never fetched
  // directly — see challengeScreenshotUrl.
  screenshot_url: string | null;
  detail: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
};

/** Same-origin proxy URL for a challenge capture, safe as an <img src>. */
export const challengeScreenshotUrl = (id: number) =>
  `/api/coordinator/challenges/${id}/screenshot`;

export type FleetFilter = 'all' | 'active' | 'attention';

// One row per UTC day the fleet reported anything; gap days are absent. The
// funnel counters are optional because a console older than them sends only
// `reviewed` and `alerted`.
export type FunnelCounter =
  | 'searches' | 'cards' | 'title_pass' | 'opened' | 'keyword_pass' | 'fresh' | 'coordinated' | 'sent';
export type ReviewStatsDay = { day: string; reviewed: number; alerted: number } & Partial<Record<FunnelCounter, number>>;

export type FilterPrompt = {
  prompt: string | null;
  rating_prompt: string | null;
  model: string | null;
};

// ── Fleet view (/v1/fleet) ─────────────────────────────────────────────────────
// One document the facade composes from fleet.toml (worker → region, proxy,
// pacing), master.toml (regions, items, search settings), the mounted monitor
// config (what the phase-1 monitor actually searches) and the coordinator's
// worker health. Field names are the facade's, verbatim.

// `per_day`, `pin` and `score` are how often the coordinator has a worker's
// city searched, and why: its alerts over the tier window, or a manager's
// pin. Absent from a facade or coordinator that predates city tiers, and from
// the regions' own lists.
export type FleetCity = {
  slug: string;
  name: string;
  radius_km: number | null;
  per_day?: number;
  pin?: number | null;
  score?: number;
};

// The rank behind each city's searches a day: the top `top_pct` percent of a
// worker's cities by alerts over `window_days` get `per_day[0]`, the next
// `mid_pct` percent `per_day[1]`, the rest `per_day[2]`.
export type CityTierSettings = {
  top_pct: number;
  mid_pct: number;
  per_day: [number, number, number];
  window_days: number;
};

// GET /api/coordinator/city-tiers. `scores` is alerts sent + reacted to per
// city slug over the window; `pins` maps a slug to a fixed searches a day.
export type CityTiers = {
  settings: CityTierSettings;
  defaults: CityTierSettings;
  pins: Record<string, number>;
  scores: Record<string, number>;
  updated_at: string | null;
  updated_by: string | null;
};

export type FleetRegion = { key: string; name: string; cities: FleetCity[] };

export type FleetItem = {
  name: string;
  enabled: boolean;
  search_phrases: string[];
  keywords: string[];
  antikeywords: string[];
  description?: string;
  min_price?: number;
  max_price?: number;
};

export type FleetSearchSettings = Partial<{
  // Sweep times, HH:MM in UTC (the workers' clock). When set they drive the
  // cadence and the intervals do not.
  start_at: string[];
  rating: number;
  min_unit_count: number;
  min_seller_rating: number;
  exclude_unrated_sellers: boolean;
  date_listed: string[] | string;
  delivery_method: string;
  max_results: number;
  title_prefilter: boolean;
  search_interval: string;
  max_search_interval: string;
  currency: string;
}>;

// 'monitor' is the phase-1 single-machine monitor described from its own
// config; 'fleet' a sharded worker from fleet.toml; 'unconfigured' a row the
// coordinator knows that no config describes.
// 'config': a worker known only from the config the console writes for it.
export type FleetAccountSource = 'monitor' | 'fleet' | 'config' | 'unconfigured';

// How a worker's city list relates to master.toml's regions. The phase-1
// monitor searches a list of its own, so the facade names it by matching
// city sets ('region' = exactly one region, 'subset', 'all', 'custom').
export type FleetScope = 'region' | 'subset' | 'all' | 'custom' | 'empty' | 'missing' | 'unknown';

// The vault's non-secret view of an account: identity, and *which* secrets
// are stored (never a value). `secrets` is keyed by the coordinator's field
// names (password, email, email_password, totp_secret, imap_host, imap_port).
export type VaultAccount = {
  account_id: string;
  fb_username: string | null;
  region: string | null;
  vnc_url: string | null;
  allow_password_login: boolean;
  proxy_configured: boolean;
  secrets: Record<string, boolean>;
};

// Metadata of the worker's backed-up browser session. `fb_user_id` is the
// session's `c_user` cookie — the public Facebook profile id, not a credential.
export type SessionMeta = {
  account_id: string | null;
  fb_user_id: string | null;
  user_agent: string | null;
  session_expiry: string | null;
  backed_up_at: string | null;
};

export type FleetAccount = {
  worker_id: string;
  source: FleetAccountSource;
  region: { key: string | null; name: string; scope: FleetScope };
  cities: FleetCity[];
  session_file: string | null;
  proxy_env: string | null;
  proxy?: FleetProxy;
  pacing: { search_interval: string | null; max_search_interval: string | null; overridden: boolean };
  vnc_url: string | null;
  // True when the facade itself can bridge to this worker's browser (it is in
  // RS_VNC_TARGETS) — the only case the ERP's own viewer can show it. A
  // `vnc_url` without it is a link someone wrote into config.
  vnc_live?: boolean;
  // null until the worker has reported at least once — or for every row when
  // the coordinator was unreachable (see FleetDoc.health).
  health: FleetWorker | null;
  // The vault account registered for this worker, and its session backup.
  // Either is null when nothing is on file (or the coordinator predates them).
  account: VaultAccount | null;
  session: SessionMeta | null;
  // The zone of the worker's region, which its "today" is counted in. This
  // and the two below are absent from a facade that predates them.
  timezone?: string;
  plan?: FleetSearchPlan;
  // null when the coordinator serves no search log or per-worker reviews.
  today?: FleetToday | null;
  // Whether the console holds this worker's config and so can save its
  // cities; absent from a facade that predates per-worker cities.
  cities_editable?: boolean;
  // The sweep times (UTC) the worker's own config runs. They differ from the
  // fleet's for an account that shares an IP. Absent from an older facade.
  start_at?: string[] | null;
};

// Where the worker's traffic comes out, which rs_console asks an IP-geo
// service through the proxy itself. `url` has any login cut out and is null on
// the VM's own IP. The exit fields are absent while the lookup is `pending` or
// after it failed (`error`).
export type FleetProxy = {
  url: string | null;
  ip?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  org?: string | null;
  error?: string;
  pending?: boolean;
};

// One city as a worker config holds it. `radius` is in kilometres.
export type CityWrite = { slug: string; name: string; radius: number };

// The daily search budget: every enabled phrase in every city, once per
// `start_at` time. `per_day` is null for an interval loop or an empty region.
export type FleetSearchPlan = {
  phrases: number;
  cities: number;
  runs_per_day: number | null;
  per_day: number | null;
};

// The worker's local day so far: `first_at` is when it started on its first
// item, `last_at` its latest counted search page. `searches` is null for a
// monitor that predates the funnel counters. `posts` are listings freshly
// put to the AI today, `alerts` those it alerted on. `cities` are the slugs
// it has searched today; null or absent from a coordinator that predates it.
export type FleetToday = {
  day: string;
  first_at: string | null;
  last_at: string | null;
  cycles: number | null;
  searches: number | null;
  posts: number | null;
  alerts: number | null;
  cities?: string[] | null;
};

export type FleetDoc = {
  generated_at: string;
  monitor_worker_id: string | null;
  sources: { master: boolean; fleet: boolean; monitor: boolean };
  health: { ok: boolean; error: string | null };
  // Builds of the two control-plane services; a worker's own build is on
  // its health row.
  versions: { console: string | null; coordinator: string | null };
  ai_model: string | null;
  search: FleetSearchSettings;
  items: FleetItem[];
  regions: FleetRegion[];
  workers: FleetAccount[];
  // The tier settings the cities' `per_day` came from; absent with them.
  city_tiers?: CityTierSettings;
  // Absent from a facade that predates saved settings; the flow card then
  // stays read-only.
  settings?: {
    editable: boolean;
    updated_at: string | null;
    updated_by: string | null;
    error: string | null;
  };
  // The week's status changes, newest first. null when the coordinator
  // predates its status log; absent from a facade that predates the field.
  status_changes?: StatusChange[] | null;
};

// One change the coordinator logged: the `state` a worker reported moving
// (HEALTHY → SESSION_EXPIRED), or its liveness crossing live → stale → dead →
// live. `was` is null on a worker's first report. `at` is when it happened.
export type StatusChange = {
  worker_id: string;
  at: string;
  kind: 'state' | 'liveness';
  was: string | null;
  became: string;
};

// What the flow card's Edit forms may save (PUT /api/coordinator/settings).
// A key left out keeps its value; the facade validates every one and writes
// them into each worker's config.
export type SearchSettingsWrite = {
  search?: FleetSearchSettings & { prompt?: string; rating_prompt?: string };
  ai_model?: string;
  items?: Record<string, Partial<Pick<FleetItem, 'search_phrases' | 'keywords' | 'antikeywords'>>>;
};

// Sent-vs-reacted counts for one (day, priority, item, city) bucket.
export type AlertHitRow = {
  day: string;
  priority: string | null;
  item_name: string | null;
  search_city: string | null;
  sent: number;
  hit: number;
};

export const coordinatorApi = {
  listWorkers: () =>
    api.get<{ workers: FleetWorker[] }>('/api/coordinator/workers').then(r => r.workers),

  reviewStats: (days: number) =>
    api.get<{ days: ReviewStatsDay[] }>(`/api/coordinator/stats/reviews?days=${days}`)
      .then(r => r.days),

  filterPrompt: () => api.get<FilterPrompt>('/api/coordinator/filter-prompt'),

  fleet: () => api.get<FleetDoc>('/api/coordinator/fleet'),

  // A save reaches every worker between jobs, and starts a sweep there.
  saveSettings: (body: SearchSettingsWrite) =>
    api.put<{ updated_at: string; updated_by: string | null; changed: string[] }>(
      '/api/coordinator/settings', body,
    ),

  alertHits: (days: number) =>
    api.get<{ rows: AlertHitRow[]; unmatched_reactions: number }>(
      `/api/coordinator/stats/alert-hits?days=${days}`,
    ).then(r => r.rows),

  listOpenChallenges: () =>
    api.get<{ challenges: Challenge[] }>('/api/coordinator/challenges?status=open')
      .then(r => r.challenges),

  // The resolver's identity comes from the session server-side, so there is
  // nothing to send.
  resolveChallenge: (id: number) =>
    api.post<{ status: string }>(`/api/coordinator/challenges/${id}/resolve`, {}),

  // Queue a Facebook re-login: the worker re-enters its username, password
  // and 2FA code from the vault on its next cycle.
  relogin: (workerId: string) =>
    api.post<unknown>(`/api/coordinator/workers/${encodeURIComponent(workerId)}/relogin`, {}),

  // Replace the cities one worker searches; it picks them up between jobs.
  saveCities: (workerId: string, cities: CityWrite[]) =>
    api.put<{ cities: CityWrite[]; changed: string[] }>(
      `/api/coordinator/workers/${encodeURIComponent(workerId)}/cities`, { cities },
    ),

  // How often cities are searched. Pins replace the whole map, so a caller
  // re-reads it just before saving and applies only its own edits.
  cityTiers: () => api.get<CityTiers>('/api/coordinator/city-tiers'),
  saveCityTiers: (body: { settings?: Partial<CityTierSettings>; pins?: Record<string, number> }) =>
    api.put<CityTiers>('/api/coordinator/city-tiers', body),
};

/**
 * The same-origin socket the backend relays to a worker's VNC session
 * (apps/backend/src/vncBridge.ts). The session cookie rides on the handshake;
 * no token ever appears in the URL.
 */
export function vncSocketUrl(workerId: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${loc.host}/api/coordinator/vnc/${encodeURIComponent(workerId)}/ws`;
}

/**
 * The close code the relay sends when its minute re-check finds the
 * handshake's session no longer valid — most often just the access token
 * running out (VNC_SESSION_LAPSED in vncBridge.ts).
 */
export const VNC_SESSION_LAPSED = 4401;
