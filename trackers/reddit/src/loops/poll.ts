// Stage 1: discover new posts.
//
// Claims every subreddit that is due, fetches them all in ONE Reddit request,
// and records what it found. The claim is taken only after the pacer says a
// request may go out — holding a claim we cannot service would hide those
// subreddits from the rest of the fleet for nothing.

import {
  claimDueSubreddits,
  insertNewPosts,
  releaseSubredditFailure,
  releaseSubredditSuccess,
  type NewPost,
} from '../claims.ts';
import type {Sql} from '../db.ts';
import type {Logger} from '../logger.ts';
import type {RedditPacer} from '../pacing.ts';
import {fetchNewPosts} from '../reddit.ts';
import type {SettingsStore} from '../settings.ts';

export interface PollDeps {
  sql: Sql;
  workerId: string;
  userAgent: string;
  pacer: RedditPacer;
  settings: SettingsStore;
  logger: Logger;
}

/** Runs one poll cycle. Returns true when it fetched something. */
export async function pollOnce(deps: PollDeps): Promise<boolean> {
  const {sql, workerId, pacer, logger} = deps;

  // Reserve the rate-limit slot first; this may block for the better part of
  // a minute, which is fine because no claim is held while we wait.
  await pacer.acquire();

  const claimed = await claimDueSubreddits(sql, workerId);
  if (claimed.length === 0) return false;

  const names = claimed.map((s) => s.name);
  const result = await fetchNewPosts(names, deps.userAgent);

  switch (result.kind) {
    case 'rate_limited':
      pacer.recordBlocked(result.retryAfterSeconds);
      await releaseSubredditFailure(sql, workerId, names, 'http_429');
      logger.warn('rate limited by reddit', {
        subreddits: names.length,
        retryAfterSeconds: result.retryAfterSeconds ?? null,
      });
      return false;

    case 'blocked':
      pacer.recordBlocked();
      await releaseSubredditFailure(sql, workerId, names, `http_${result.status}`);
      logger.warn('blocked by reddit', {status: result.status, subreddits: names.length});
      return false;

    case 'error':
      await releaseSubredditFailure(sql, workerId, names, result.message);
      logger.warn('reddit fetch failed', {error: result.message});
      return false;

    case 'ok':
      break;
  }

  pacer.recordSuccess();
  pacer.recordRateLimit(result.rateLimit);

  const {maxPostAgeHours} = await deps.settings.get();
  const cutoff = Date.now() - maxPostAgeHours * 3600_000;

  // Dropping old posts at insert time is the cheapest cost guard there is: it
  // keeps the first-ever poll of a subreddit from queueing a day of backlog
  // for LLM evaluation.
  const claimedNames = new Set(names);
  const fresh: NewPost[] = result.posts
    .filter((p) => p.postedAt.getTime() >= cutoff)
    // A multireddit response only ever contains the subs we asked for, but
    // guard anyway so a redirect can never write rows we did not claim.
    .filter((p) => claimedNames.has(p.subreddit))
    .map((p) => ({
      redditId: p.redditId,
      subreddit: p.subreddit,
      title: p.title,
      selftext: p.selftext,
      author: p.author,
      flair: p.flair,
      url: p.url,
      postedAt: p.postedAt,
    }));

  const inserted = await insertNewPosts(sql, fresh);
  await releaseSubredditSuccess(sql, workerId, names);

  logger.info('polled subreddits', {
    subreddits: names.length,
    fetched: result.posts.length,
    fresh: fresh.length,
    new: inserted.length,
  });

  return true;
}
