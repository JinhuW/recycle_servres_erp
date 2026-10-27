// Stage 3: alert the buyers.
//
// Only posts the LLM marked as targets reach here, and the claim they are
// taken under is what guarantees a single Telegram message per post no matter
// how many workers are running. Each alert's message ids are recorded so
// reactions on it can be traced back to the post, and with dev chats
// configured a review copy follows it there. A cross-post of a listing buyers
// already have is parked as a duplicate instead (see dedup.ts).

import type {AlertSender} from '../alerts.ts';
import {claimPosts, markDuplicate, markNotified, releasePostFailure} from '../claims.ts';
import type {Sql} from '../db.ts';
import {findAlertedCopy} from '../dedup.ts';
import type {Logger} from '../logger.ts';
import {sendReview} from '../review.ts';
import type {SettingsStore} from '../settings.ts';

export const NOTIFY_BATCH_SIZE = 5;

export interface NotifyDeps {
  sql: Sql;
  workerId: string;
  alerts: AlertSender;
  settings: SettingsStore;
  logger: Logger;
}

export async function notifyOnce(deps: NotifyDeps): Promise<boolean> {
  const {sql, workerId, logger} = deps;

  const settings = await deps.settings.get();
  if (deps.alerts.requiresRecipients && settings.telegramChatIds.length === 0) {
    // Nothing configured to notify. Leave targets queued rather than marking
    // them notified, so they go out once a chat id is added via the API.
    return false;
  }

  const posts = await claimPosts(sql, workerId, 'target', NOTIFY_BATCH_SIZE);
  if (posts.length === 0) return false;

  for (const post of posts) {
    const copyOf = await findAlertedCopy(sql, post);
    if (copyOf) {
      await markDuplicate(sql, workerId, post.reddit_id, copyOf);
      logger.info('duplicate listing not alerted', {
        redditId: post.reddit_id,
        subreddit: post.subreddit,
        duplicateOf: copyOf,
      });
      continue;
    }

    const alert = {
      subreddit: post.subreddit,
      summary: post.llm_summary ?? post.title,
      price: post.llm_price,
      url: post.url,
      title: post.title,
    };
    const report = await deps.alerts.send(settings.telegramChatIds, alert);

    if (report.delivered.length > 0) {
      // A partial delivery still counts as sent: retrying would spam the chats
      // that already received it, which is worse than one logged miss.
      await markNotified(sql, workerId, post.reddit_id, report.sent);
      logger.event('alert_sent', {
        redditId: post.reddit_id,
        subreddit: post.subreddit,
        title: post.title,
        url: post.url,
        summary: post.llm_summary ?? post.title,
        price: post.llm_price,
        transport: deps.alerts.transport,
        promptVersionId: post.prompt_version_id,
        delivered: report.delivered.length,
        failed: report.failed.length,
      });
      if (report.failed.length > 0) {
        logger.warn('some chats did not receive the alert', {failures: report.failed});
      }
      if (settings.telegramDevChatIds.length > 0) {
        await sendReview(deps, settings.telegramDevChatIds, post.reddit_id, alert);
      }
    } else {
      await releasePostFailure(sql, workerId, post.reddit_id);
      logger.warn('alert delivery failed to every chat', {
        redditId: post.reddit_id,
        failures: report.failed,
      });
    }
  }

  return true;
}
