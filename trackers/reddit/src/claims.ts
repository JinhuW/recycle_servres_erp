// Fleet coordination. Every worker runs the same loops against the same
// database; these queries are what stop them from duplicating each other's
// work. Two mechanisms do all of it:
//
//   1. FOR UPDATE SKIP LOCKED + an inline claim-TTL check, so a row claimed by
//      one worker is invisible to every other worker's claim query. That is
//      the guarantee that two VMs never fetch the same subreddit at once.
//   2. INSERT ... ON CONFLICT DO NOTHING on the post primary key, so a post
//      seen by several workers is evaluated and alerted exactly once.
//
// Claims are advisory metadata rather than held locks: expiry is evaluated in
// the claim query itself, so a worker that dies mid-task releases its work
// after CLAIM_TTL with no reaper process involved.

import type {Sql} from './db.ts';
import type {SentMessage} from './telegram.ts';

/** How long a claim stays valid before another worker may steal it. */
export const CLAIM_TTL_SECONDS = 300;

/**
 * Subreddits claimed per poll cycle. They are fetched in ONE combined Reddit
 * request (r/a+b+c/new.json), so a larger batch means more posts per request
 * against the rate limit — but Reddit truncates very long multireddit paths,
 * and a batch is re-fetched whole on failure, so 20 is the practical ceiling.
 */
export const SUBREDDIT_BATCH_SIZE = 20;

export const MAX_ATTEMPTS = 5;

export interface SubredditRow {
  name: string;
  enabled: boolean;
  poll_interval_seconds: number;
  next_poll_at: Date;
  claimed_by: string | null;
  claimed_at: Date | null;
  last_polled_at: Date | null;
  last_status: string | null;
  consecutive_errors: number;
}

export interface PostRow {
  reddit_id: string;
  subreddit: string;
  title: string;
  selftext: string;
  author: string | null;
  flair: string | null;
  url: string;
  posted_at: Date;
  status: string;
  is_target: boolean | null;
  llm_summary: string | null;
  llm_price: string | null;
  reject_reason: string | null;
  attempts: number;
  prompt_version_id: number | null;
}

export interface NewPost {
  redditId: string;
  subreddit: string;
  title: string;
  selftext: string;
  author: string | null;
  flair: string | null;
  url: string;
  postedAt: Date;
}

/**
 * Claims every subreddit that is due for polling, up to the batch size.
 * Concurrent callers receive disjoint sets — SKIP LOCKED hands each worker
 * only rows no one else is touching.
 */
export async function claimDueSubreddits(
  sql: Sql,
  workerId: string,
  limit: number = SUBREDDIT_BATCH_SIZE,
): Promise<SubredditRow[]> {
  const rows = await sql<SubredditRow[]>`
    UPDATE subreddits s
       SET claimed_by = ${workerId}, claimed_at = NOW()
     WHERE s.name IN (
       SELECT name FROM subreddits
        WHERE enabled
          AND next_poll_at <= NOW()
          AND (claimed_at IS NULL
               OR claimed_at < NOW() - make_interval(secs => ${CLAIM_TTL_SECONDS}))
        ORDER BY next_poll_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING s.*`;
  return [...rows];
}

/** Releases a successfully polled subreddit and schedules its next poll. */
export async function releaseSubredditSuccess(
  sql: Sql,
  workerId: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  await sql`
    UPDATE subreddits
       SET claimed_by = NULL,
           claimed_at = NULL,
           last_polled_at = NOW(),
           last_status = 'ok',
           consecutive_errors = 0,
           next_poll_at = NOW() + make_interval(secs => poll_interval_seconds)
     WHERE name = ANY(${names}) AND claimed_by = ${workerId}`;
}

/**
 * Releases a subreddit that failed to poll, backing its next attempt off
 * exponentially. This is per-subreddit backoff (a sub that got deleted or
 * privated), distinct from the process-wide IP backoff in pacing.ts.
 */
export async function releaseSubredditFailure(
  sql: Sql,
  workerId: string,
  names: string[],
  status: string,
): Promise<void> {
  if (names.length === 0) return;
  await sql`
    UPDATE subreddits
       SET claimed_by = NULL,
           claimed_at = NULL,
           last_polled_at = NOW(),
           last_status = ${status.slice(0, 200)},
           consecutive_errors = consecutive_errors + 1,
           next_poll_at = NOW() + LEAST(
             make_interval(secs => poll_interval_seconds * POWER(2, consecutive_errors + 1)),
             INTERVAL '30 minutes'
           )
     WHERE name = ANY(${names}) AND claimed_by = ${workerId}`;
}

/**
 * Inserts freshly fetched posts, ignoring any already known to the fleet.
 * Returns the ids that were genuinely new, which is also the count of posts
 * this worker won the race to record.
 */
export async function insertNewPosts(sql: Sql, posts: NewPost[]): Promise<string[]> {
  if (posts.length === 0) return [];
  const values = posts.map((p) => ({
    reddit_id: p.redditId,
    subreddit: p.subreddit,
    title: p.title,
    selftext: p.selftext,
    author: p.author,
    flair: p.flair,
    url: p.url,
    posted_at: p.postedAt,
  }));
  const inserted = await sql`
    INSERT INTO posts ${sql(values)}
    ON CONFLICT (reddit_id) DO NOTHING
    RETURNING reddit_id`;
  return inserted.map((r) => r['reddit_id'] as string);
}

/** Claims posts sitting in `status` and due for another attempt. */
export async function claimPosts(
  sql: Sql,
  workerId: string,
  status: 'new' | 'target',
  limit: number,
): Promise<PostRow[]> {
  const rows = await sql<PostRow[]>`
    UPDATE posts p
       SET claimed_by = ${workerId}, claimed_at = NOW()
     WHERE p.reddit_id IN (
       SELECT reddit_id FROM posts
        WHERE status = ${status}
          AND next_retry_at <= NOW()
          AND (claimed_at IS NULL
               OR claimed_at < NOW() - make_interval(secs => ${CLAIM_TTL_SECONDS}))
        ORDER BY next_retry_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING p.*`;
  return [...rows];
}

/** Records an LLM verdict and routes the post to alerting or to the archive. */
export async function recordEvaluation(
  sql: Sql,
  workerId: string,
  redditId: string,
  verdict: {
    isTarget: boolean;
    summary: string;
    price: string | null;
    raw: unknown;
    promptVersionId: number;
  },
): Promise<void> {
  await sql`
    UPDATE posts
       SET status = ${verdict.isTarget ? 'target' : 'rejected'},
           is_target = ${verdict.isTarget},
           llm_summary = ${verdict.summary},
           llm_price = ${verdict.price},
           llm_raw = ${sql.json(verdict.raw as never)},
           prompt_version_id = ${verdict.promptVersionId},
           reject_reason = ${verdict.isTarget ? null : 'not_target'},
           attempts = 0,
           claimed_by = NULL,
           claimed_at = NULL
     WHERE reddit_id = ${redditId} AND claimed_by = ${workerId}`;
}

/** Rejects a post without spending an LLM call (currently: too old). */
export async function rejectPost(
  sql: Sql,
  workerId: string,
  redditId: string,
  reason: string,
): Promise<void> {
  await sql`
    UPDATE posts
       SET status = 'rejected',
           is_target = FALSE,
           reject_reason = ${reason},
           claimed_by = NULL,
           claimed_at = NULL
     WHERE reddit_id = ${redditId} AND claimed_by = ${workerId}`;
}

/**
 * Marks a target post as alerted and records the buyer messages it went out
 * as. One statement, so a post is never notified without the message ids its
 * reactions will arrive under. The messages are recorded even if the claim was
 * lost meanwhile: they were sent, and reactions on them are real.
 */
export async function markNotified(
  sql: Sql,
  workerId: string,
  redditId: string,
  sent: ReadonlyArray<SentMessage> = [],
): Promise<void> {
  await sql`
    WITH notified AS (
      UPDATE posts
         SET status = 'notified',
             notified_at = NOW(),
             attempts = 0,
             claimed_by = NULL,
             claimed_at = NULL
       WHERE reddit_id = ${redditId} AND claimed_by = ${workerId}
    )
    ${insertAlertMessages(sql, redditId, 'buyers', sent)}`;
}

/** Parks a target whose listing buyers already got through another copy. */
export async function markDuplicate(
  sql: Sql,
  workerId: string,
  redditId: string,
  duplicateOf: string,
): Promise<void> {
  await sql`
    UPDATE posts
       SET status = 'duplicate',
           duplicate_of = ${duplicateOf},
           claimed_by = NULL,
           claimed_at = NULL
     WHERE reddit_id = ${redditId} AND claimed_by = ${workerId}`;
}

/** Puts a post back for a later pass without counting it as a failed attempt. */
export async function deferPost(
  sql: Sql,
  workerId: string,
  redditId: string,
  seconds: number,
): Promise<void> {
  await sql`
    UPDATE posts
       SET next_retry_at = NOW() + make_interval(secs => ${seconds}),
           claimed_by = NULL,
           claimed_at = NULL
     WHERE reddit_id = ${redditId} AND claimed_by = ${workerId}`;
}

/** Records the messages a dev-chat review of a post went out as. */
export async function recordReviewMessages(
  sql: Sql,
  redditId: string,
  sent: ReadonlyArray<SentMessage>,
): Promise<void> {
  if (sent.length === 0) return;
  await sql`${insertAlertMessages(sql, redditId, 'dev', sent)}`;
}

function insertAlertMessages(
  sql: Sql,
  redditId: string,
  audience: 'buyers' | 'dev',
  sent: ReadonlyArray<SentMessage>,
) {
  return sql`
    INSERT INTO alert_messages (chat_id, message_id, reddit_id, audience, sent_as)
    SELECT m.chat_id, m.message_id::bigint, ${redditId}, ${audience}, m.sent_as
      FROM unnest(${sent.map((m) => m.chatId)}::text[],
                  ${sent.map((m) => String(m.messageId))}::text[],
                  ${sent.map((m) => m.sentAs ?? 'bot')}::text[]) AS m(chat_id, message_id, sent_as)
    ON CONFLICT (chat_id, message_id) DO NOTHING`;
}

/**
 * Releases a post whose stage failed, scheduling a retry with exponential
 * backoff. After MAX_ATTEMPTS the post parks in 'failed' so a transient bug
 * cannot burn API budget forever; the API can requeue it.
 */
export async function releasePostFailure(
  sql: Sql,
  workerId: string,
  redditId: string,
): Promise<void> {
  await sql`
    UPDATE posts
       SET attempts = attempts + 1,
           status = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE status END,
           next_retry_at = NOW() + LEAST(
             make_interval(secs => 30 * POWER(2, attempts)),
             INTERVAL '15 minutes'
           ),
           claimed_by = NULL,
           claimed_at = NULL
     WHERE reddit_id = ${redditId} AND claimed_by = ${workerId}`;
}

/**
 * Returns a failed post to the queue. Posts that already have a verdict go
 * back to notifying; the rest go back to evaluation.
 */
export async function requeuePost(sql: Sql, redditId: string): Promise<boolean> {
  const rows = await sql`
    UPDATE posts
       SET status = CASE WHEN is_target IS TRUE THEN 'target' ELSE 'new' END,
           attempts = 0,
           next_retry_at = NOW(),
           claimed_by = NULL,
           claimed_at = NULL
     WHERE reddit_id = ${redditId}
    RETURNING reddit_id`;
  return rows.length > 0;
}

/**
 * Takes or renews the named lease. True when this worker holds it now: it
 * already did, or the last holder let it lapse.
 */
export async function holdLease(
  sql: Sql,
  name: string,
  workerId: string,
  ttlSeconds: number,
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO loop_leases (name, worker_id, expires_at)
    VALUES (${name}, ${workerId}, NOW() + make_interval(secs => ${ttlSeconds}))
    ON CONFLICT (name) DO UPDATE
      SET worker_id = EXCLUDED.worker_id, expires_at = EXCLUDED.expires_at
      WHERE loop_leases.worker_id = EXCLUDED.worker_id OR loop_leases.expires_at < NOW()
    RETURNING worker_id`;
  return rows.length > 0;
}

/** Gives a lease up at once, so another worker need not wait out its TTL. */
export async function releaseLease(sql: Sql, name: string, workerId: string): Promise<void> {
  await sql`DELETE FROM loop_leases WHERE name = ${name} AND worker_id = ${workerId}`;
}

/** Releases claims held by this worker so a restart does not wait out the TTL. */
export async function releaseAllClaims(sql: Sql, workerId: string): Promise<void> {
  await sql`UPDATE subreddits SET claimed_by = NULL, claimed_at = NULL
             WHERE claimed_by = ${workerId}`;
  await sql`UPDATE posts SET claimed_by = NULL, claimed_at = NULL
             WHERE claimed_by = ${workerId}`;
  await sql`DELETE FROM loop_leases WHERE worker_id = ${workerId}`;
}
