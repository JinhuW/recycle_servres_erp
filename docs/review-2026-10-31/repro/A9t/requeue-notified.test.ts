// Repro for A9t-05. Copy into trackers/reddit/tests/ and run with
// TEST_DATABASE_URL pointing at a disposable Postgres:
//   npx vitest run tests/requeue-notified.test.ts
// Fails today: requeuePost accepts a post in any status, so requeueing one that
// buyers already got puts it back to 'target' and notifyOnce alerts it again.

import {afterAll, afterEach, beforeAll, expect, it, vi} from 'vitest';
import {createTelegramAlertSender} from '../src/alerts.ts';
import {insertNewPosts, requeuePost} from '../src/claims.ts';
import {createLogger} from '../src/logger.ts';
import {notifyOnce} from '../src/loops/notify.ts';
import {SettingsStore} from '../src/settings.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb('requeue_repro');
}, 60_000);
afterAll(async () => {
  await db.drop();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('never re-alerts a post buyers already got when it is requeued', async () => {
  await db.sql`UPDATE settings SET value = '["chat-1"]'::jsonb WHERE key = 'telegram_chat_ids'`;
  await insertNewPosts(db.sql, [{
    redditId: 't3_done', subreddit: 'homelabsales', title: '[FS] 16x 64GB DDR4 RDIMM',
    selftext: '', author: 'seller', flair: null,
    url: 'https://www.reddit.com/r/homelabsales/comments/done/', postedAt: new Date(),
  }]);
  await db.sql`UPDATE posts SET status = 'target', is_target = TRUE, llm_summary = 's'
                WHERE reddit_id = 't3_done'`;
  let id = 1;
  const telegram = vi.fn().mockImplementation(async () => new Response(
    JSON.stringify({ok: true, result: {message_id: id++}}), {status: 200}));
  vi.stubGlobal('fetch', telegram);
  const deps = {
    sql: db.sql, workerId: 'w', alerts: createTelegramAlertSender('bot'),
    settings: new SettingsStore(db.sql, 0), logger: createLogger('w', 'error'),
  };

  await notifyOnce(deps);
  expect(telegram).toHaveBeenCalledTimes(1);

  // POST /api/posts/t3_done/requeue, e.g. a mistyped id from the failed list.
  await requeuePost(db.sql, 't3_done');
  await notifyOnce(deps);

  expect(telegram).toHaveBeenCalledTimes(1);
});
