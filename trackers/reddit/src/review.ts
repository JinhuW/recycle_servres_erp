// Dev-chat reviews. Every live alert, and every post only the candidate
// flagged, goes to the dev chats with each prompt's verdict and reasoning, so
// whoever reads them can label it with a reaction. Best effort by design: a
// review that does not arrive costs one label, never a buyer alert, so there
// is no retry queue behind it.

import type {AlertSender} from './alerts.ts';
import {recordReviewMessages} from './claims.ts';
import type {Sql} from './db.ts';
import type {Logger} from './logger.ts';
import {verdictNotes} from './prompts.ts';
import type {AlertContent} from './telegram.ts';

export interface ReviewDeps {
  sql: Sql;
  alerts: AlertSender;
  logger: Logger;
}

export async function sendReview(
  deps: ReviewDeps,
  chatIds: string[],
  redditId: string,
  alert: AlertContent,
): Promise<void> {
  const verdicts = await verdictNotes(deps.sql, redditId);
  const report = await deps.alerts.sendReview(chatIds, {alert, verdicts});
  await recordReviewMessages(deps.sql, redditId, report.sent);
  if (report.failed.length > 0) {
    deps.logger.warn('review did not reach every dev chat', {redditId, failures: report.failed});
  }
}
