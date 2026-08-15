// Stage 2: decide which discovered posts are worth buying.
//
// Runs independently of polling so a slow or failing LLM never stalls post
// discovery, and vice versa.

import {claimPosts, recordEvaluation, rejectPost, releasePostFailure} from '../claims.ts';
import type {Sql} from '../db.ts';
import {evaluatePost} from '../llm.ts';
import type {Logger} from '../logger.ts';
import {composeEvalPrompt, listRules} from '../rules.ts';
import type {SettingsStore} from '../settings.ts';

/** Small batch: each item is a paid API call, and claims should turn over fast. */
export const EVALUATE_BATCH_SIZE = 3;

export interface EvaluateDeps {
  sql: Sql;
  workerId: string;
  apiKey: string;
  settings: SettingsStore;
  logger: Logger;
}

export async function evaluateOnce(deps: EvaluateDeps): Promise<boolean> {
  const {sql, workerId, logger} = deps;

  const posts = await claimPosts(sql, workerId, 'new', EVALUATE_BATCH_SIZE);
  if (posts.length === 0) return false;

  const settings = await deps.settings.get();
  const cutoff = Date.now() - settings.maxPostAgeHours * 3600_000;
  // One cheap SELECT per batch keeps rule edits reaching the fleet as fast as
  // a settings change, without another cache to invalidate.
  const enabledRules = (await listRules(sql)).filter((r) => r.enabled);
  const systemPrompt = composeEvalPrompt(settings.evalPrompt, enabledRules);

  for (const post of posts) {
    // Re-check age here as well as at insert: a post can go stale while it
    // waits behind a backlog, and a stale listing is not worth paying for.
    if (post.posted_at.getTime() < cutoff) {
      await rejectPost(sql, workerId, post.reddit_id, 'too_old');
      logger.debug('skipped stale post', {redditId: post.reddit_id});
      continue;
    }

    const result = await evaluatePost(
      {
        subreddit: post.subreddit,
        title: post.title,
        selftext: post.selftext,
        author: post.author,
      },
      {apiKey: deps.apiKey, model: settings.llmModel, systemPrompt},
    );

    if (result.kind === 'error') {
      await releasePostFailure(sql, workerId, post.reddit_id);
      logger.warn('evaluation failed', {redditId: post.reddit_id, error: result.message});
      continue;
    }

    const {evaluation} = result;
    await recordEvaluation(sql, workerId, post.reddit_id, {
      isTarget: evaluation.isTarget,
      summary: evaluation.summary,
      price: evaluation.price,
      raw: evaluation.raw,
    });

    logger.info(evaluation.isTarget ? 'target found' : 'post rejected', {
      redditId: post.reddit_id,
      subreddit: post.subreddit,
      title: post.title.slice(0, 80),
    });
  }

  return true;
}
