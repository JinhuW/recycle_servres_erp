// How the tracker is doing over a window: what it saw, what it alerted, how
// buyers took the alerts, and — from the PM tracer — which wanted memory
// listings it let through. Read by the ERP's Reddit ▸ Analytics tab.
//
// Two signals score an alert. A reaction is the buyers' own verdict: any emoji
// but 👎 is a good catch (message_labels). PMs are the market's: a memory post
// that drew HOT_PMS or more buyers and no good-catch reaction is "missing",
// whether it never alerted or alerted and nobody acted on it.

import type {Sql} from './db.ts';
import {TRACE_AFTER_HOURS, TRACER_LEASE} from './loops/trace.ts';

export type AnalyticsWindow = '24h' | '7d' | '30d';
export const ANALYTICS_WINDOWS: readonly AnalyticsWindow[] = ['24h', '7d', '30d'];

const WINDOW_HOURS: Record<AnalyticsWindow, number> = {'24h': 24, '7d': 168, '30d': 720};

/** Buyers who asked by PM for a post to count as wanted. */
export const HOT_PMS = 5;
const LIST_LIMIT = 25;

// The posts "missing" is about: anything that talks about memory, by the same
// words the RS-404 evaluation set was drawn with. One place, so every number
// on the page means the same thing by it.
const MEMORY_PATTERN =
  '\\m(ram|memory|ecc|ddr[345]\\w*|[a-z]*dimms?|so-dimms?|pc[345]-\\w+)\\M';

export interface Range {
  since: string;
  until: string;
}

export interface ListedPost {
  redditId: string;
  subreddit: string;
  title: string;
  url: string;
  postedAt: string;
  pmCount: number;
  commentCount: number;
  /** Alerted to buyers, itself or through a cross-post copy. */
  alerted: boolean;
  /** Why the prompt said no, or null when it alerted. */
  reasoning: string | null;
  promptVersionId: number | null;
}

export interface Analytics {
  window: AnalyticsWindow;
  generatedAt: string;
  /** Posted in this range: volume, feedback, speed. */
  range: Range;
  /**
   * The same length of time ending TRACE_AFTER_HOURS ago, because the tracer
   * only counts a post's PMs once it is that old. Demand numbers use this.
   */
  demandRange: Range;
  hotPms: number;
  volume: {
    posts: number;
    judged: number;
    memoryPosts: number;
    alerts: number;
    duplicates: number;
    failed: number;
    alertsPerDay: number;
  };
  feedback: {alerts: number; good: number; bad: number; unreacted: number};
  speed: {medianMinutes: number | null; p90Minutes: number | null};
  demand: {
    posts: number;
    traced: number;
    memoryTraced: number;
    hotMemory: number;
    /** Hot memory posts alerted and reacted to as a good catch. */
    caught: number;
    alertedNoReaction: number;
    notAlerted: number;
    missing: number;
    avgPmsAlerted: number | null;
    avgPmsRejected: number | null;
  };
  missing: ListedPost[];
  /** Hot posts that are not about memory, for a sense of what else sells. */
  hotOther: ListedPost[];
  subreddits: Array<{
    name: string;
    posts: number;
    memoryPosts: number;
    alerts: number;
    good: number;
    traced: number;
    avgPms: number | null;
    hotMemory: number;
    missing: number;
  }>;
  prompts: Array<{
    versionId: number;
    model: string;
    role: 'live' | 'candidate' | 'retired';
    judged: number;
    flagged: number;
    good: number;
    bad: number;
    hotMemoryJudged: number;
    hotMemoryFlagged: number;
  }>;
  series: {
    bucket: 'hour' | 'day';
    points: Array<{until: string; posts: number; alerts: number; good: number; missing: number}>;
  };
  tracer: {workerId: string; expiresAt: string} | null;
}

const round1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10);

export async function analytics(
  sql: Sql,
  options: {window: AnalyticsWindow; liveHash: string; candidateHash: string | null; now?: Date},
): Promise<Analytics> {
  const hours = WINDOW_HOURS[options.window];
  const until = options.now ?? new Date();
  const since = new Date(until.getTime() - hours * 3600_000);
  const demandUntil = new Date(until.getTime() - TRACE_AFTER_HOURS * 3600_000);
  const demandSince = new Date(since.getTime() - TRACE_AFTER_HOURS * 3600_000);
  const bucketHours = options.window === '24h' ? 1 : 24;

  // Per post, across both audiences, with a cross-post copy taking the label
  // of the alert buyers actually got.
  const labelled = () => sql`
    labels AS (
      SELECT am.reddit_id,
             COALESCE(bool_or(ml.positive), FALSE) AS positive,
             COALESCE(bool_or(ml.negative), FALSE) AS negative
        FROM alert_messages am
        LEFT JOIN message_labels ml ON ml.chat_id = am.chat_id AND ml.message_id = am.message_id
       GROUP BY am.reddit_id
    ),
    scored AS (
      SELECT p.*,
             (p.title || ' ' || p.selftext) ~* ${MEMORY_PATTERN} AS memory,
             (p.status = 'notified' OR p.status = 'duplicate') AS alerted,
             COALESCE(l.positive, FALSE) AS good,
             COALESCE(l.negative AND NOT l.positive, FALSE) AS bad
        FROM posts p
        LEFT JOIN labels l ON l.reddit_id = COALESCE(p.duplicate_of, p.reddit_id)
    )`;
  const hot = sql`(s.memory AND s.pm_count >= ${HOT_PMS})`;
  const missed = sql`(${hot} AND NOT s.good)`;
  // Open-ended: the database clock may run a little ahead of this process's.
  const inRange = sql`s.posted_at >= ${since}`;
  const inDemand = sql`s.posted_at >= ${demandSince} AND s.posted_at < ${demandUntil}`;

  const listed = (where: typeof missed) => sql<ListedRow[]>`
    WITH ${labelled()}
    SELECT s.reddit_id, s.subreddit, s.title, s.url, s.posted_at, s.pm_count, s.comment_count,
           s.alerted, s.prompt_version_id,
           CASE WHEN s.alerted THEN NULL ELSE COALESCE(s.llm_raw->>'reasoning', s.reject_reason) END
             AS reasoning
      FROM scored s
     WHERE ${inDemand} AND ${where}
     ORDER BY s.pm_count DESC, s.posted_at DESC
     LIMIT ${LIST_LIMIT}`;

  const [totals, demand, missing, hotOther, subreddits, prompts, series, lease] = await Promise.all([
    sql<Array<{
      posts: number; judged: number; memory_posts: number; alerts: number; duplicates: number;
      failed: number; good: number; bad: number; median_min: number | null; p90_min: number | null;
    }>>`
      WITH ${labelled()}
      SELECT COUNT(*)::int AS posts,
             COUNT(*) FILTER (WHERE s.is_target IS NOT NULL)::int AS judged,
             COUNT(*) FILTER (WHERE s.memory)::int AS memory_posts,
             COUNT(*) FILTER (WHERE s.status = 'notified')::int AS alerts,
             COUNT(*) FILTER (WHERE s.status = 'duplicate')::int AS duplicates,
             COUNT(*) FILTER (WHERE s.status = 'failed')::int AS failed,
             COUNT(*) FILTER (WHERE s.status = 'notified' AND s.good)::int AS good,
             COUNT(*) FILTER (WHERE s.status = 'notified' AND s.bad)::int AS bad,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM s.notified_at - s.posted_at) / 60)
               FILTER (WHERE s.status = 'notified') AS median_min,
             percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM s.notified_at - s.posted_at) / 60)
               FILTER (WHERE s.status = 'notified') AS p90_min
        FROM scored s
       WHERE ${inRange}`,
    sql<Array<{
      posts: number; traced: number; memory_traced: number; hot: number; caught: number;
      alerted_no_reaction: number; not_alerted: number; avg_alerted: number | null;
      avg_rejected: number | null;
    }>>`
      WITH ${labelled()}
      SELECT COUNT(*)::int AS posts,
             COUNT(*) FILTER (WHERE s.pm_count IS NOT NULL)::int AS traced,
             COUNT(*) FILTER (WHERE s.pm_count IS NOT NULL AND s.memory)::int AS memory_traced,
             COUNT(*) FILTER (WHERE ${hot})::int AS hot,
             COUNT(*) FILTER (WHERE ${hot} AND s.good)::int AS caught,
             COUNT(*) FILTER (WHERE ${missed} AND s.alerted)::int AS alerted_no_reaction,
             COUNT(*) FILTER (WHERE ${missed} AND NOT s.alerted)::int AS not_alerted,
             AVG(s.pm_count) FILTER (WHERE s.memory AND s.alerted) AS avg_alerted,
             AVG(s.pm_count) FILTER (WHERE s.memory AND NOT s.alerted AND s.is_target IS NOT NULL)
               AS avg_rejected
        FROM scored s
       WHERE ${inDemand}`,
    listed(missed),
    listed(sql`NOT s.memory AND s.pm_count >= ${HOT_PMS}`),
    sql<Array<{
      name: string; posts: number; memory_posts: number; alerts: number; good: number;
      traced: number; avg_pms: number | null; hot: number; missing: number;
    }>>`
      WITH ${labelled()}
      SELECT s.subreddit AS name,
             COUNT(*) FILTER (WHERE ${inRange})::int AS posts,
             COUNT(*) FILTER (WHERE ${inRange} AND s.memory)::int AS memory_posts,
             COUNT(*) FILTER (WHERE ${inRange} AND s.status = 'notified')::int AS alerts,
             COUNT(*) FILTER (WHERE ${inRange} AND s.status = 'notified' AND s.good)::int AS good,
             COUNT(*) FILTER (WHERE ${inDemand} AND s.pm_count IS NOT NULL)::int AS traced,
             AVG(s.pm_count) FILTER (WHERE ${inDemand}) AS avg_pms,
             COUNT(*) FILTER (WHERE ${inDemand} AND ${hot})::int AS hot,
             COUNT(*) FILTER (WHERE ${inDemand} AND ${missed})::int AS missing
        FROM scored s
       WHERE s.posted_at >= ${demandSince}
       GROUP BY s.subreddit
       ORDER BY posts DESC, name`,
    // Live verdicts and candidate verdicts alike, so a trial's PM recall
    // reads next to the live prompt's on the same posts.
    sql<Array<{
      version_id: number; model: string; hash: string; judged: number; flagged: number;
      good: number; bad: number; hot_judged: number; hot_flagged: number;
    }>>`
      WITH ${labelled()},
      verdicts AS (
        SELECT s.prompt_version_id AS version_id, s.reddit_id, s.is_target
          FROM scored s
         WHERE s.prompt_version_id IS NOT NULL AND s.is_target IS NOT NULL
        UNION
        SELECT cv.prompt_version_id, cv.reddit_id, cv.is_target FROM candidate_verdicts cv
      )
      SELECT v.version_id, pv.model, pv.hash,
             COUNT(*) FILTER (WHERE ${inRange})::int AS judged,
             COUNT(*) FILTER (WHERE ${inRange} AND v.is_target)::int AS flagged,
             COUNT(*) FILTER (WHERE ${inRange} AND v.is_target AND s.good)::int AS good,
             COUNT(*) FILTER (WHERE ${inRange} AND v.is_target AND s.bad)::int AS bad,
             COUNT(*) FILTER (WHERE ${inDemand} AND ${hot})::int AS hot_judged,
             COUNT(*) FILTER (WHERE ${inDemand} AND ${hot} AND v.is_target)::int AS hot_flagged
        FROM verdicts v
        JOIN scored s ON s.reddit_id = v.reddit_id
        JOIN prompt_versions pv ON pv.id = v.version_id
       WHERE s.posted_at >= ${demandSince}
       GROUP BY v.version_id, pv.model, pv.hash
      HAVING COUNT(*) FILTER (WHERE ${inRange} OR (${inDemand} AND ${hot})) > 0
       ORDER BY v.version_id DESC`,
    // Fixed-width buckets ending now rather than calendar days, so the chart
    // reads the same in any timezone.
    sql<Array<{until: Date; posts: number; alerts: number; good: number; missing: number}>>`
      WITH ${labelled()},
      buckets AS (
        SELECT ${since}::timestamptz + make_interval(hours => ${bucketHours} * i) AS b_since,
               ${since}::timestamptz + make_interval(hours => ${bucketHours} * (i + 1)) AS b_until
          FROM generate_series(0, ${hours / bucketHours - 1}) AS i
      )
      SELECT b.b_until AS until,
             COUNT(s.reddit_id)::int AS posts,
             COUNT(s.reddit_id) FILTER (WHERE s.status = 'notified')::int AS alerts,
             COUNT(s.reddit_id) FILTER (WHERE s.status = 'notified' AND s.good)::int AS good,
             COUNT(s.reddit_id) FILTER (WHERE ${missed})::int AS missing
        FROM buckets b
        LEFT JOIN scored s ON s.posted_at >= b.b_since AND s.posted_at < b.b_until
       GROUP BY b.b_until
       ORDER BY b.b_until`,
    sql<Array<{worker_id: string; expires_at: Date}>>`
      SELECT worker_id, expires_at FROM loop_leases
       WHERE name = ${TRACER_LEASE} AND expires_at > NOW()`,
  ]);

  const t = totals[0]!;
  const d = demand[0]!;
  return {
    window: options.window,
    generatedAt: until.toISOString(),
    range: {since: since.toISOString(), until: until.toISOString()},
    demandRange: {since: demandSince.toISOString(), until: demandUntil.toISOString()},
    hotPms: HOT_PMS,
    volume: {
      posts: t.posts,
      judged: t.judged,
      memoryPosts: t.memory_posts,
      alerts: t.alerts,
      duplicates: t.duplicates,
      failed: t.failed,
      alertsPerDay: round1(t.alerts / (hours / 24))!,
    },
    feedback: {alerts: t.alerts, good: t.good, bad: t.bad, unreacted: t.alerts - t.good - t.bad},
    speed: {medianMinutes: round1(t.median_min), p90Minutes: round1(t.p90_min)},
    demand: {
      posts: d.posts,
      traced: d.traced,
      memoryTraced: d.memory_traced,
      hotMemory: d.hot,
      caught: d.caught,
      alertedNoReaction: d.alerted_no_reaction,
      notAlerted: d.not_alerted,
      missing: d.alerted_no_reaction + d.not_alerted,
      avgPmsAlerted: round1(d.avg_alerted === null ? null : Number(d.avg_alerted)),
      avgPmsRejected: round1(d.avg_rejected === null ? null : Number(d.avg_rejected)),
    },
    missing: missing.map(toListed),
    hotOther: hotOther.map(toListed),
    subreddits: subreddits.map((s) => ({
      name: s.name,
      posts: s.posts,
      memoryPosts: s.memory_posts,
      alerts: s.alerts,
      good: s.good,
      traced: s.traced,
      avgPms: round1(s.avg_pms === null ? null : Number(s.avg_pms)),
      hotMemory: s.hot,
      missing: s.missing,
    })),
    prompts: prompts.map((p) => ({
      versionId: p.version_id,
      model: p.model,
      role: p.hash === options.liveHash ? 'live' : p.hash === options.candidateHash ? 'candidate' : 'retired',
      judged: p.judged,
      flagged: p.flagged,
      good: p.good,
      bad: p.bad,
      hotMemoryJudged: p.hot_judged,
      hotMemoryFlagged: p.hot_flagged,
    })),
    series: {
      bucket: bucketHours === 1 ? 'hour' : 'day',
      points: series.map((p) => ({
        until: p.until.toISOString(),
        posts: p.posts,
        alerts: p.alerts,
        good: p.good,
        missing: p.missing,
      })),
    },
    tracer: lease[0] ? {workerId: lease[0].worker_id, expiresAt: lease[0].expires_at.toISOString()} : null,
  };
}

interface ListedRow {
  reddit_id: string;
  subreddit: string;
  title: string;
  url: string;
  posted_at: Date;
  pm_count: number;
  comment_count: number;
  alerted: boolean;
  prompt_version_id: number | null;
  reasoning: string | null;
}

function toListed(r: ListedRow): ListedPost {
  return {
    redditId: r.reddit_id,
    subreddit: r.subreddit,
    title: r.title,
    url: r.url,
    postedAt: r.posted_at.toISOString(),
    pmCount: r.pm_count,
    commentCount: r.comment_count,
    alerted: r.alerted,
    reasoning: r.reasoning,
    promptVersionId: r.prompt_version_id,
  };
}
