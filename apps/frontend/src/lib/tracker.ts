// Typed client for the Reddit tracker admin proxy (/api/tracker/*, manager-
// only). The backend forwards these calls to the `trackers/reddit` admin API
// with its bearer token; a 501 from any of them means the proxy env vars are
// unset.

import { api } from './api';

export type TrackerWorkerRole = 'worker' | 'api';
export type LoopName = 'poll' | 'evaluate' | 'notify';
export type LoopStatus = { lastSuccessAt: string | null; lastWorkAt: string | null };

export type TrackerWorker = {
  workerId: string;
  role: TrackerWorkerRole;
  startedAt: string;
  lastHeartbeatAt: string;
  secondsSinceHeartbeat: number;
  // The api role runs no loops; workers report all three.
  loops: Partial<Record<LoopName, LoopStatus>>;
};

export type TrackerRule = {
  id: number;
  name: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

// snake_case on purpose: this row passes through the proxy verbatim from the
// tracker's GET /api/subreddits.
export type TrackerSubreddit = {
  name: string;
  enabled: boolean;
  poll_interval_seconds: number;
  next_poll_at: string | null;
  last_polled_at: string | null;
  last_status: string | null;
  consecutive_errors: number;
  claimed_by: string | null;
};

// Mirrors the tracker API's own validation so the form can reject bad input
// before a round-trip.
const SUBREDDIT_NAME_RE = /^[A-Za-z0-9_]{2,30}$/;
export const MIN_POLL_INTERVAL_S = 30;

/** Trims, strips a leading r/ or /r/, lowercases; null when invalid. */
export function normalizeSubredditName(input: string): string | null {
  const name = input.trim().replace(/^\/?r\//, '');
  return SUBREDDIT_NAME_RE.test(name) ? name.toLowerCase() : null;
}

export type WorkerStatusFilter = 'all' | 'live' | 'stale' | 'dead';

export type PostStatus = 'new' | 'rejected' | 'target' | 'notified' | 'failed';

// A post the evaluator judged a target, as GET /api/matches returns it.
export type TrackerMatch = {
  redditId: string;
  subreddit: string;
  title: string;
  summary: string | null;
  price: string | null;
  url: string;
  postedAt: string;
  discoveredAt: string;
  notifiedAt: string | null;
  status: PostStatus;
};

// Counts by status of the posts discovered since the `since` asked for (a
// status with no posts is absent). The oldest post still waiting for the
// evaluator and the newest failures ignore the window.
export type TrackerStats = {
  posts: Partial<Record<PostStatus, number>>;
  oldestPending: { reddit_id: string; discovered_at: string } | null;
  failed: Array<{ reddit_id: string; title: string; attempts: number }>;
};

export const WORKERS_PAGE_SIZE = 15;

export const trackerApi = {
  listWorkers: (params: { status: WorkerStatusFilter; limit: number; offset: number }) =>
    api.get<{ workers: TrackerWorker[]; total: number }>(
      `/api/tracker/workers?status=${params.status}&limit=${params.limit}&offset=${params.offset}`,
    ),
  // One COUNT per status: the tracker judges liveness in SQL, and a limit=1
  // page carries the total without shipping the rows.
  workerCounts: () =>
    Promise.all((['live', 'stale', 'dead'] as const).map(status =>
      api.get<{ total: number }>(`/api/tracker/workers?status=${status}&limit=1&offset=0`)
        .then(r => [status, r.total] as const),
    )).then(entries => Object.fromEntries(entries) as Record<'live' | 'stale' | 'dead', number>),
  removeWorker: (workerId: string) =>
    api.delete(`/api/tracker/workers/${encodeURIComponent(workerId)}`),

  listRules: () =>
    api.get<{ rules: TrackerRule[] }>('/api/tracker/rules').then(r => r.rules),
  createRule: (input: { name: string; prompt: string }) =>
    api.post<{ rule: TrackerRule }>('/api/tracker/rules', input).then(r => r.rule),
  updateRule: (id: number, patch: { name?: string; prompt?: string; enabled?: boolean }) =>
    api.patch<{ rule: TrackerRule }>(`/api/tracker/rules/${id}`, patch).then(r => r.rule),
  deleteRule: (id: number) => api.delete(`/api/tracker/rules/${id}`),

  listMatches: (limit: number) =>
    api.get<{ matches: TrackerMatch[] }>(`/api/tracker/matches?limit=${limit}`).then(r => r.matches),
  stats: (since: Date) =>
    api.get<TrackerStats>(`/api/tracker/stats?since=${encodeURIComponent(since.toISOString())}`),

  listSubreddits: () =>
    api.get<{ subreddits: TrackerSubreddit[] }>('/api/tracker/subreddits').then(r => r.subreddits),
  addSubreddit: (input: { name: string; pollIntervalSeconds?: number }) =>
    api.post<{ subreddit: TrackerSubreddit }>('/api/tracker/subreddits', input).then(r => r.subreddit),
  updateSubreddit: (name: string, patch: { enabled?: boolean; pollIntervalSeconds?: number }) =>
    api.patch<{ subreddit: TrackerSubreddit }>(
      `/api/tracker/subreddits/${encodeURIComponent(name)}`, patch,
    ).then(r => r.subreddit),
  deleteSubreddit: (name: string) =>
    api.delete(`/api/tracker/subreddits/${encodeURIComponent(name)}`),
};
