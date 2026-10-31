// A9-02 repro: a worker with ALERT_TRANSPORT=console claims a shared-DB target,
// prints it, and marks it notified with no Telegram message ever sent.
import {afterAll, beforeAll, expect, it, vi} from '../../../../trackers/reddit/node_modules/vitest/dist/index.js';
import {createConsoleAlertSender} from '../../../../trackers/reddit/src/alerts.ts';
import {insertNewPosts} from '../../../../trackers/reddit/src/claims.ts';
import {createLogger} from '../../../../trackers/reddit/src/logger.ts';
import {notifyOnce} from '../../../../trackers/reddit/src/loops/notify.ts';
import {SettingsStore} from '../../../../trackers/reddit/src/settings.ts';
import {createTestDb, type TestDb} from '../../../../trackers/reddit/tests/helpers/db.ts';

let db: TestDb;
beforeAll(async () => { db = await createTestDb('a9v'); });
afterAll(async () => { await db.drop(); });

it('console worker marks a real buyer target notified without sending anything', async () => {
  await db.sql`UPDATE settings SET value = '["buyer-chat"]'::jsonb WHERE key = 'telegram_chat_ids'`;
  await insertNewPosts(db.sql, [{redditId: 't3_x', subreddit: 'homelabsales', title: '[FS] R730',
    selftext: '', author: 's', flair: null, url: 'https://reddit.com/x', postedAt: new Date()}]);
  await db.sql`UPDATE posts SET status = 'target' WHERE reddit_id = 't3_x'`;
  const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
  const printed: string[] = [];
  const did = await notifyOnce({sql: db.sql, workerId: 'console-worker', deferToUserSender: true,
    alerts: createConsoleAlertSender((t) => printed.push(t)),
    settings: new SettingsStore(db.sql, 0), logger: createLogger('console-worker', 'error')});
  const [row] = await db.sql`SELECT status, notified_at FROM posts WHERE reddit_id = 't3_x'`;
  const [{n}] = await db.sql`SELECT count(*)::int AS n FROM alert_messages`.catch(() => [{n: 'n/a'}]);
  console.log('A9-02 result', {did, status: row.status, notified: row.notified_at !== null, fetchCalls: fetchSpy.mock.calls.length, printed: printed.length, alert_messages: n});
  expect(row.status).toBe('notified');
  expect(fetchSpy).not.toHaveBeenCalled();
});
