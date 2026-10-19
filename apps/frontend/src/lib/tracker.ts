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

// ─── Prompt versions and trials (GET /api/prompt-stats) ─────────────────────
// A version is the exact model + system prompt a post was judged with. A lead
// is an alert someone reacted to with anything but 👎; a 👎 alone makes it a
// not-lead. Counts cover the posts discovered since the `since` asked for.

export type PromptRole = 'live' | 'candidate' | 'retired';

export type ResponseSchema = 'verdict-first' | 'reasoning-first';

export type AudienceScore = { sent: number; leads: number; notLeads: number; leadRate: number | null };

export type TrialCell = { posts: number; leads: number; notLeads: number };

// The candidate's verdicts against the live prompt's on the same posts.
export type VsLive = { both: TrialCell; liveOnly: TrialCell; candidateOnly: TrialCell; neither: TrialCell };

export type PromptVersionStats = {
  id: number;
  role: PromptRole;
  model: string;
  systemPrompt: string;
  // The same wording under another response schema is another version; the
  // tracker labels every version made before reasoning moved first as such.
  responseSchema: ResponseSchema;
  firstUsedAt: string;
  lastUsedAt: string;
  evaluated: number;
  targets: number;
  targetRate: number | null;
  buyers: AudienceScore;
  dev: AudienceScore;
  vsLive?: VsLive;
};

// A prompt as configured now; its version id is null until it has judged a post.
export type ConfiguredPrompt = { model: string; systemPrompt: string; promptVersionId: number | null };

export type PromptStats = {
  versions: PromptVersionStats[];
  unmatchedReactions: number;
  config: { live: ConfiguredPrompt; candidate: ConfiguredPrompt | null; enabledRules: number };
};

/** Below this many labelled posts a trial's numbers are anecdotes, not evidence. */
export const TRIAL_MIN_LABELLED = 20;

export type TrialSummary = {
  labelled: number;
  unlabelled: number;
  /** Leads only the candidate alerted on. */
  leadsGained: number;
  /** Leads only the live prompt alerted on: what promoting would lose. */
  leadsLost: number;
  /** 👎 alerts only the live prompt sent: junk promoting would drop. */
  junkDropped: number;
  /** 👎 alerts only the candidate sent: junk promoting would add. */
  junkAdded: number;
  enoughData: boolean;
};

/**
 * The trial in the terms the decision is made in. Posts both prompts rejected
 * were never sent anywhere, so they can't be labelled and don't count either way.
 */
export function summarizeTrial(vs: VsLive): TrialSummary {
  const sent = [vs.both, vs.liveOnly, vs.candidateOnly];
  const labelled = sent.reduce((sum, c) => sum + c.leads + c.notLeads, 0);
  const posts = sent.reduce((sum, c) => sum + c.posts, 0);
  return {
    labelled,
    unlabelled: posts - labelled,
    leadsGained: vs.candidateOnly.leads,
    leadsLost: vs.liveOnly.leads,
    junkDropped: vs.liveOnly.notLeads,
    junkAdded: vs.candidateOnly.notLeads,
    enoughData: labelled >= TRIAL_MIN_LABELLED,
  };
}

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

  // null asks for all time.
  promptStats: (since: Date | null) =>
    api.get<PromptStats>(
      `/api/tracker/prompt-stats${since ? `?since=${encodeURIComponent(since.toISOString())}` : ''}`,
    ),
  // '' runs the candidate on the live model.
  setCandidate: (input: { prompt: string; model: string }) =>
    api.put<{ candidate: ConfiguredPrompt }>('/api/tracker/prompt-candidate', input).then(r => r.candidate),
  clearCandidate: () => api.delete('/api/tracker/prompt-candidate'),
  promoteCandidate: () =>
    api.post<{ evalPrompt: string; llmModel: string; disabledRules: number[]; promptVersionId: number | null }>(
      '/api/tracker/prompt-candidate/promote', {},
    ),

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
