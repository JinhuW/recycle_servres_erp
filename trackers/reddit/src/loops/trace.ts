// Demand tracing: once a post is a day old, count the buyers who asked for it.
//
// On the swap subreddits a buyer comments "PM" (or "chat sent") and takes the
// deal private, so the number of distinct commenters doing that is the best
// public measure of how wanted a listing was. Analytics compares it with what
// the prompt alerted on: a memory post that drew many PMs and no alert, or an
// alert nobody reacted to, is a lead the tracker missed.
//
// One worker at a time does this, under the `comment_tracer` lease. It costs one
// Reddit request per post (~110 a day) out of that worker's pacer budget.

import {holdLease, releaseLease} from '../claims.ts';
import type {Sql} from '../db.ts';
import type {Logger} from '../logger.ts';
import type {RedditPacer} from '../pacing.ts';
import {fetchComments, type RedditComment} from '../reddit.ts';

export const TRACER_LEASE = 'comment_tracer';
const LEASE_TTL_SECONDS = 600;
/** PMs have mostly arrived a day after posting; earlier counts read low. */
export const TRACE_AFTER_HOURS = 24;
/** How far back an untraced post is still worth a request. */
export const TRACE_WITHIN_DAYS = 8;
/** After a block, this worker leaves the lease to the rest of the fleet for a while. */
const STAND_DOWN_MS = 30 * 60_000;

// "PM", "PM'd", "pmed", "pming", "DM'd", "chat sent", "sent you a message"…
const PM_PATTERN =
  /\b(?:pm(?:'?d|'?ed|'?ing|s)?|dm(?:'?d|'?ed|'?ing|s)?|chat(?:'?d|ted|ting|s)?|messaged|sent (?:you )?(?:a )?(?:pm|dm|chat|message))\b/i;
// Swap-confirmation and moderation bots post on every listing.
const BOT_AUTHOR = /^(?:automoderator|.*bot)$/i;

export interface TraceCounts {
  comments: number;
  pms: number;
}

/** Distinct commenters, other than the seller and bots, asking by PM or chat. */
export function countPms(comments: ReadonlyArray<RedditComment>, opAuthor: string | null): TraceCounts {
  const op = opAuthor?.toLowerCase() ?? null;
  const buyers = new Set<string>();
  for (const c of comments) {
    const author = c.author?.toLowerCase();
    if (!author || author === op || author === '[deleted]' || BOT_AUTHOR.test(author)) continue;
    if (PM_PATTERN.test(c.text)) buyers.add(author);
  }
  return {comments: comments.length, pms: buyers.size};
}

export interface TraceDeps {
  sql: Sql;
  workerId: string;
  userAgent: string;
  pacer: RedditPacer;
  logger: Logger;
  now?: () => number;
}

interface TracePost {
  reddit_id: string;
  url: string;
  author: string | null;
}

export class Tracer {
  private standDownUntil = 0;

  constructor(private readonly deps: TraceDeps) {}

  /** Traces one post. Returns true when it did. */
  async once(): Promise<boolean> {
    const {sql, workerId, pacer, logger} = this.deps;
    const now = this.deps.now?.() ?? Date.now();
    if (now < this.standDownUntil) return false;
    if (!await holdLease(sql, TRACER_LEASE, workerId, LEASE_TTL_SECONDS)) return false;

    const [post] = await sql<TracePost[]>`
      SELECT reddit_id, url, author FROM posts
       WHERE comments_checked_at IS NULL
         AND posted_at < NOW() - make_interval(hours => ${TRACE_AFTER_HOURS})
         AND posted_at > NOW() - make_interval(days => ${TRACE_WITHIN_DAYS})
       ORDER BY posted_at DESC
       LIMIT 1`;
    if (!post) return false;

    await pacer.acquire();
    const result = await fetchComments(post.url, this.deps.userAgent);

    switch (result.kind) {
      case 'rate_limited':
      case 'blocked':
        // This IP is out of favour; the poll loop needs what budget it has, and
        // another worker's IP may be fine.
        pacer.recordBlocked(result.kind === 'rate_limited' ? result.retryAfterSeconds : undefined);
        this.standDownUntil = now + STAND_DOWN_MS;
        await releaseLease(sql, TRACER_LEASE, workerId);
        logger.info('reddit refused the comment feed; leaving tracing to another worker', {
          redditId: post.reddit_id,
          result: result.kind,
        });
        return false;

      case 'gone':
      case 'error':
        // Removed posts and one-off failures alike are not retried: the queue
        // is newest first, and a post that always fails would hold it up.
        await sql`UPDATE posts SET comments_checked_at = NOW() WHERE reddit_id = ${post.reddit_id}`;
        logger.info('comment feed unreadable', {
          redditId: post.reddit_id,
          reason: result.kind === 'gone' ? 'gone' : result.message,
        });
        return true;

      case 'ok':
        break;
    }

    pacer.recordSuccess();
    pacer.recordRateLimit(result.rateLimit);
    const counts = countPms(result.comments, post.author);
    await sql`
      UPDATE posts
         SET comments_checked_at = NOW(), comment_count = ${counts.comments}, pm_count = ${counts.pms}
       WHERE reddit_id = ${post.reddit_id}`;
    return true;
  }
}
