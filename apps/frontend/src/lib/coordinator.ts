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

// One row per UTC day the fleet reported anything; gap days are absent.
export type ReviewStatsDay = { day: string; reviewed: number; alerted: number };

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

export type FleetCity = { slug: string; name: string; radius_km: number | null };

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
export type FleetAccountSource = 'monitor' | 'fleet' | 'unconfigured';

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
  pacing: { search_interval: string | null; max_search_interval: string | null; overridden: boolean };
  vnc_url: string | null;
  // null until the worker has reported at least once — or for every row when
  // the coordinator was unreachable (see FleetDoc.health).
  health: FleetWorker | null;
  // The vault account registered for this worker, and its session backup.
  // Either is null when nothing is on file (or the coordinator predates them).
  account: VaultAccount | null;
  session: SessionMeta | null;
};

export type FleetDoc = {
  generated_at: string;
  monitor_worker_id: string | null;
  sources: { master: boolean; fleet: boolean; monitor: boolean };
  health: { ok: boolean; error: string | null };
  ai_model: string | null;
  search: FleetSearchSettings;
  items: FleetItem[];
  regions: FleetRegion[];
  workers: FleetAccount[];
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
};
