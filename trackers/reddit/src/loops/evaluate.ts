// Stage 2: decide which discovered posts are worth buying.
//
// Runs independently of polling so a slow or failing LLM never stalls post
// discovery, and vice versa.
//
// When a candidate prompt is on trial, each post is judged a second time by
// it. The candidate never changes a post's status — only the live verdict
// does — so a candidate can reach the dev chat but never the buyers.

import type {AlertSender} from '../alerts.ts';
import {claimPosts, recordEvaluation, rejectPost, releasePostFailure} from '../claims.ts';
import type {Sql} from '../db.ts';
import {evaluatePost, type Evaluation} from '../llm.ts';
import type {Logger} from '../logger.ts';
import {
  candidateConfig,
  ensurePromptVersion,
  liveConfig,
  recordCandidateVerdict,
} from '../prompts.ts';
import {sendReview} from '../review.ts';
import {listRules} from '../rules.ts';
import type {SettingsStore} from '../settings.ts';

/** Small batch: each item is a paid API call, and claims should turn over fast. */
export const EVALUATE_BATCH_SIZE = 3;

export interface EvaluateDeps {
  sql: Sql;
  workerId: string;
  apiKey: string;
  settings: SettingsStore;
  /** Sends the dev-chat review of a post only the candidate flagged. */
  alerts: AlertSender;
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
  const live = liveConfig(settings, enabledRules);
  const liveVersionId = await ensurePromptVersion(sql, live);
  const candidate = candidateConfig(settings);
  const candidateVersionId = candidate ? await ensurePromptVersion(sql, candidate) : null;

  for (const post of posts) {
    // Every outcome ends in exactly one post_evaluated event carrying the
    // post itself and the filter's verdict, so the prompt's behaviour can be
    // audited from OpenSearch alone (event: post_evaluated, verdict: …).
    const postFields = {
      redditId: post.reddit_id,
      subreddit: post.subreddit,
      title: post.title,
      // Enough body to judge the verdict without shipping 8k-char posts.
      selftext: post.selftext.slice(0, 500),
      author: post.author,
      url: post.url,
      postedAt: post.posted_at.toISOString(),
      model: live.model,
      promptVersionId: liveVersionId,
    };

    // Re-check age here as well as at insert: a post can go stale while it
    // waits behind a backlog, and a stale listing is not worth paying for.
    if (post.posted_at.getTime() < cutoff) {
      await rejectPost(sql, workerId, post.reddit_id, 'too_old');
      logger.event('post_evaluated', {...postFields, verdict: 'rejected', rejectReason: 'too_old'});
      continue;
    }

    const input = {
      subreddit: post.subreddit,
      title: post.title,
      selftext: post.selftext,
      author: post.author,
    };
    const result = await evaluatePost(input, {apiKey: deps.apiKey, ...live});

    if (result.kind === 'error') {
      // The candidate waits for the retry too, so both verdicts on a post
      // always come from the same attempt.
      await releasePostFailure(sql, workerId, post.reddit_id);
      logger.warn('evaluation failed', {redditId: post.reddit_id, error: result.message});
      logger.event('post_evaluated', {
        ...postFields,
        verdict: 'error',
        error: result.message,
        attempt: post.attempts + 1,
      });
      continue;
    }

    let candidateVerdict: Evaluation | null = null;
    if (candidate && candidateVersionId !== null) {
      const trial = await evaluatePost(input, {apiKey: deps.apiKey, ...candidate});
      if (trial.kind === 'ok') {
        candidateVerdict = trial.evaluation;
        await recordCandidateVerdict(sql, post.reddit_id, candidateVersionId, candidateVerdict);
      } else {
        // Not retried: a missing candidate verdict costs one comparison, and
        // retrying would hold up the live verdict buyers are waiting on.
        logger.warn('candidate evaluation failed', {
          redditId: post.reddit_id,
          error: trial.message,
        });
      }
    }

    const {evaluation} = result;
    await recordEvaluation(sql, workerId, post.reddit_id, {
      isTarget: evaluation.isTarget,
      summary: evaluation.summary,
      price: evaluation.price,
      raw: evaluation.raw,
      promptVersionId: liveVersionId,
    });

    // A live target is reviewed when it is alerted. A post only the candidate
    // flagged never reaches the notify stage, so its review goes out here —
    // once, since 'rejected' is terminal and no other stage claims it again.
    if (
      candidateVerdict?.isTarget
      && !evaluation.isTarget
      && settings.telegramDevChatIds.length > 0
    ) {
      await sendReview(deps, settings.telegramDevChatIds, post.reddit_id, {
        subreddit: post.subreddit,
        summary: candidateVerdict.summary || post.title,
        price: candidateVerdict.price,
        url: post.url,
        title: post.title,
      });
    }

    logger.event('post_evaluated', {
      ...postFields,
      verdict: evaluation.isTarget ? 'target' : 'rejected',
      ...(evaluation.isTarget ? {} : {rejectReason: 'not_target'}),
      summary: evaluation.summary,
      price: evaluation.price,
      reasoning: evaluation.reasoning,
      ...(candidateVerdict
        ? {
          candidateVersionId,
          candidateVerdict: candidateVerdict.isTarget ? 'target' : 'rejected',
          candidateReasoning: candidateVerdict.reasoning,
        }
        : {}),
    });
  }

  return true;
}
