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
// rather than re-deriving one from timestamps it sees late.
export type WorkerLiveness = 'live' | 'stale' | 'dead';

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

export type FleetFilter = 'all' | 'attention';

// One row per UTC day the fleet reported anything; gap days are absent.
export type ReviewStatsDay = { day: string; reviewed: number; alerted: number };

export type FilterPrompt = {
  prompt: string | null;
  rating_prompt: string | null;
  model: string | null;
};

export const coordinatorApi = {
  listWorkers: () =>
    api.get<{ workers: FleetWorker[] }>('/api/coordinator/workers').then(r => r.workers),

  reviewStats: (days: number) =>
    api.get<{ days: ReviewStatsDay[] }>(`/api/coordinator/stats/reviews?days=${days}`)
      .then(r => r.days),

  filterPrompt: () => api.get<FilterPrompt>('/api/coordinator/filter-prompt'),

  listOpenChallenges: () =>
    api.get<{ challenges: Challenge[] }>('/api/coordinator/challenges?status=open')
      .then(r => r.challenges),

  // The resolver's identity comes from the session server-side, so there is
  // nothing to send.
  resolveChallenge: (id: number) =>
    api.post<{ status: string }>(`/api/coordinator/challenges/${id}/resolve`, {}),
};
