import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  claimDueSubreddits,
  claimPosts,
  insertNewPosts,
  markNotified,
  recordEvaluation,
  releaseAllClaims,
  releasePostFailure,
  releaseSubredditFailure,
  releaseSubredditSuccess,
  requeuePost,
  type NewPost,
} from '../src/claims.ts';
import {ensurePromptVersion} from '../src/prompts.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

let db: TestDb;
let promptVersionId: number;

beforeAll(async () => {
  db = await createTestDb('claims');
  promptVersionId = await ensurePromptVersion(db.sql, {model: 'test/model', systemPrompt: 'test'});
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.sql`DELETE FROM posts`;
  await db.sql`DELETE FROM subreddits`;
});

function samplePost(overrides: Partial<NewPost> = {}): NewPost {
  return {
    redditId: 't3_aaa',
    subreddit: 'homelabsales',
    title: '[FS] Dell R730 with 2x E5-2680v4',
    selftext: 'Asking $400 shipped CONUS.',
    author: 'someseller',
    flair: 'FS',
    url: 'https://www.reddit.com/r/homelabsales/comments/aaa/fs_dell_r730/',
    postedAt: new Date(),
    ...overrides,
  };
}

describe('subreddit claiming', () => {
  it('gives concurrent workers disjoint subreddits so none is fetched twice', async () => {
    await db.sql`
      INSERT INTO subreddits (name, next_poll_at) VALUES
        ('a', NOW()), ('b', NOW()), ('c', NOW()), ('d', NOW())`;

    const [first, second] = await Promise.all([
      claimDueSubreddits(db.sql, 'worker-1'),
      claimDueSubreddits(db.sql, 'worker-2'),
    ]);

    const firstNames = first.map((r) => r.name);
    const secondNames = second.map((r) => r.name);
    expect(firstNames.filter((n) => secondNames.includes(n))).toEqual([]);
    expect([...firstNames, ...secondNames].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('claims a whole batch in one call so one Reddit request covers many subs', async () => {
    await db.sql`
      INSERT INTO subreddits (name, next_poll_at)
      SELECT 'sub' || g, NOW() FROM generate_series(1, 12) g`;

    const claimed = await claimDueSubreddits(db.sql, 'worker-1');

    expect(claimed).toHaveLength(12);
  });

  it('does not hand out a subreddit that is not due yet', async () => {
    await db.sql`
      INSERT INTO subreddits (name, next_poll_at)
      VALUES ('later', NOW() + INTERVAL '10 minutes')`;

    expect(await claimDueSubreddits(db.sql, 'worker-1')).toEqual([]);
  });

  it('skips disabled subreddits', async () => {
    await db.sql`INSERT INTO subreddits (name, enabled) VALUES ('off', FALSE)`;

    expect(await claimDueSubreddits(db.sql, 'worker-1')).toEqual([]);
  });

  it('lets another worker take over a claim left by a dead worker', async () => {
    await db.sql`INSERT INTO subreddits (name) VALUES ('stuck')`;
    await claimDueSubreddits(db.sql, 'dead-worker');

    expect(await claimDueSubreddits(db.sql, 'worker-2')).toEqual([]);

    await db.sql`UPDATE subreddits SET claimed_at = NOW() - INTERVAL '6 minutes'`;
    const recovered = await claimDueSubreddits(db.sql, 'worker-2');

    expect(recovered.map((r) => r.name)).toEqual(['stuck']);
    expect(recovered[0]?.claimed_by).toBe('worker-2');
  });

  it('schedules the next poll one interval out on success', async () => {
    await db.sql`INSERT INTO subreddits (name, poll_interval_seconds) VALUES ('a', 90)`;
    await claimDueSubreddits(db.sql, 'worker-1');

    await releaseSubredditSuccess(db.sql, 'worker-1', ['a']);

    const [row] = await db.sql<Array<{secs: number; claimed_by: string | null; last_status: string}>>`
      SELECT EXTRACT(EPOCH FROM next_poll_at - NOW())::float AS secs, claimed_by, last_status
        FROM subreddits WHERE name = 'a'`;
    expect(row?.secs).toBeGreaterThan(80);
    expect(row?.secs).toBeLessThan(95);
    expect(row?.claimed_by).toBeNull();
    expect(row?.last_status).toBe('ok');
  });

  it('backs a failing subreddit off exponentially, capped at 30 minutes', async () => {
    await db.sql`INSERT INTO subreddits (name, poll_interval_seconds) VALUES ('a', 90)`;

    await claimDueSubreddits(db.sql, 'worker-1');
    await releaseSubredditFailure(db.sql, 'worker-1', ['a'], 'http_403');
    const first = await delaySeconds('a');
    expect(first).toBeGreaterThan(170);
    expect(first).toBeLessThan(190);

    await db.sql`UPDATE subreddits SET next_poll_at = NOW()`;
    await claimDueSubreddits(db.sql, 'worker-1');
    await releaseSubredditFailure(db.sql, 'worker-1', ['a'], 'http_403');
    const second = await delaySeconds('a');
    expect(second).toBeGreaterThan(350);

    await db.sql`UPDATE subreddits SET consecutive_errors = 20, next_poll_at = NOW()`;
    await claimDueSubreddits(db.sql, 'worker-1');
    await releaseSubredditFailure(db.sql, 'worker-1', ['a'], 'http_403');
    expect(await delaySeconds('a')).toBeLessThanOrEqual(1800);
  });

  it('ignores a release from a worker that no longer holds the claim', async () => {
    await db.sql`INSERT INTO subreddits (name) VALUES ('a')`;
    await claimDueSubreddits(db.sql, 'worker-1');

    await releaseSubredditSuccess(db.sql, 'impostor', ['a']);

    const [row] = await db.sql<Array<{claimed_by: string | null}>>`
      SELECT claimed_by FROM subreddits WHERE name = 'a'`;
    expect(row?.claimed_by).toBe('worker-1');
  });

  async function delaySeconds(name: string): Promise<number> {
    const [row] = await db.sql<Array<{secs: number}>>`
      SELECT EXTRACT(EPOCH FROM next_poll_at - NOW())::float AS secs
        FROM subreddits WHERE name = ${name}`;
    return row?.secs ?? 0;
  }
});

describe('post deduplication', () => {
  it('reports only the posts this worker recorded first', async () => {
    const posts = [samplePost({redditId: 't3_one'}), samplePost({redditId: 't3_two'})];

    expect((await insertNewPosts(db.sql, posts)).sort()).toEqual(['t3_one', 't3_two']);
    expect(await insertNewPosts(db.sql, posts)).toEqual([]);
  });

  it('keeps one row when several workers fetch the same post at once', async () => {
    const post = samplePost({redditId: 't3_race'});

    const results = await Promise.all([
      insertNewPosts(db.sql, [post]),
      insertNewPosts(db.sql, [post]),
      insertNewPosts(db.sql, [post]),
    ]);

    expect(results.flat()).toEqual(['t3_race']);
    const [row] = await db.sql<Array<{count: string}>>`SELECT COUNT(*) AS count FROM posts`;
    expect(row?.count).toBe('1');
  });

  it('handles an empty fetch without touching the database', async () => {
    expect(await insertNewPosts(db.sql, [])).toEqual([]);
  });
});

describe('post claiming and lifecycle', () => {
  it('gives concurrent workers disjoint posts to evaluate', async () => {
    await insertNewPosts(
      db.sql,
      Array.from({length: 6}, (_, i) => samplePost({redditId: `t3_${i}`})),
    );

    const [first, second] = await Promise.all([
      claimPosts(db.sql, 'worker-1', 'new', 3),
      claimPosts(db.sql, 'worker-2', 'new', 3),
    ]);

    const ids = [...first, ...second].map((p) => p.reddit_id);
    expect(new Set(ids).size).toBe(6);
  });

  it('moves a target through evaluation to notified', async () => {
    await insertNewPosts(db.sql, [samplePost({redditId: 't3_x'})]);
    await claimPosts(db.sql, 'worker-1', 'new', 1);

    await recordEvaluation(db.sql, 'worker-1', 't3_x', {
      isTarget: true,
      summary: 'Dell R730, $400 shipped.',
      price: '$400 shipped',
      raw: {is_target: true},
      promptVersionId,
    });

    const pending = await claimPosts(db.sql, 'worker-1', 'target', 5);
    expect(pending.map((p) => p.reddit_id)).toEqual(['t3_x']);

    await markNotified(db.sql, 'worker-1', 't3_x');
    const [row] = await db.sql<Array<{status: string; notified_at: Date | null}>>`
      SELECT status, notified_at FROM posts WHERE reddit_id = 't3_x'`;
    expect(row?.status).toBe('notified');
    expect(row?.notified_at).not.toBeNull();
  });

  it('records the buyer messages a post went out as, which reactions join on', async () => {
    await insertNewPosts(db.sql, [samplePost({redditId: 't3_m'})]);
    await db.sql`UPDATE posts SET status = 'target', is_target = TRUE WHERE reddit_id = 't3_m'`;
    await claimPosts(db.sql, 'worker-1', 'target', 1);

    await markNotified(db.sql, 'worker-1', 't3_m', [
      {chatId: '-100111', messageId: 42},
      {chatId: '-100222', messageId: 7},
    ]);

    const rows = await db.sql<Array<{chat_id: string; message_id: string; audience: string}>>`
      SELECT chat_id, message_id::text, audience FROM alert_messages
       WHERE reddit_id = 't3_m' ORDER BY chat_id`;
    expect(rows.map((r) => [r.chat_id, r.message_id, r.audience])).toEqual([
      ['-100111', '42', 'buyers'],
      ['-100222', '7', 'buyers'],
    ]);
  });

  it('keeps the message ids even when the claim was lost, since the alert did go out', async () => {
    await insertNewPosts(db.sql, [samplePost({redditId: 't3_lost'})]);
    await db.sql`UPDATE posts SET status = 'target', is_target = TRUE WHERE reddit_id = 't3_lost'`;
    await claimPosts(db.sql, 'worker-1', 'target', 1);
    await db.sql`UPDATE posts SET claimed_by = 'worker-2' WHERE reddit_id = 't3_lost'`;

    await markNotified(db.sql, 'worker-1', 't3_lost', [{chatId: '-100111', messageId: 43}]);

    const [post] = await db.sql<Array<{status: string}>>`
      SELECT status FROM posts WHERE reddit_id = 't3_lost'`;
    expect(post?.status).toBe('target');
    const [message] = await db.sql<Array<{n: number}>>`
      SELECT COUNT(*)::int AS n FROM alert_messages WHERE reddit_id = 't3_lost'`;
    expect(message?.n).toBe(1);
  });

  it('leaves a rejected post out of the notify queue', async () => {
    await insertNewPosts(db.sql, [samplePost({redditId: 't3_no'})]);
    await claimPosts(db.sql, 'worker-1', 'new', 1);

    await recordEvaluation(db.sql, 'worker-1', 't3_no', {
      isTarget: false,
      summary: 'Someone asking for build advice.',
      price: null,
      raw: {is_target: false},
      promptVersionId,
    });

    expect(await claimPosts(db.sql, 'worker-1', 'target', 5)).toEqual([]);
  });

  it('parks a post as failed after five attempts and requeues it on demand', async () => {
    await insertNewPosts(db.sql, [samplePost({redditId: 't3_bad'})]);

    for (let i = 0; i < 5; i++) {
      await db.sql`UPDATE posts SET next_retry_at = NOW()`;
      const claimed = await claimPosts(db.sql, 'worker-1', 'new', 1);
      expect(claimed).toHaveLength(1);
      await releasePostFailure(db.sql, 'worker-1', 't3_bad');
    }

    const [failed] = await db.sql<Array<{status: string; attempts: number}>>`
      SELECT status, attempts FROM posts WHERE reddit_id = 't3_bad'`;
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(5);

    expect(await requeuePost(db.sql, 't3_bad')).toBe(true);
    const [requeued] = await db.sql<Array<{status: string; attempts: number}>>`
      SELECT status, attempts FROM posts WHERE reddit_id = 't3_bad'`;
    expect(requeued?.status).toBe('new');
    expect(requeued?.attempts).toBe(0);
  });

  it('sends an already-evaluated target back to notifying when requeued', async () => {
    await insertNewPosts(db.sql, [samplePost({redditId: 't3_t'})]);
    await claimPosts(db.sql, 'worker-1', 'new', 1);
    await recordEvaluation(db.sql, 'worker-1', 't3_t', {
      isTarget: true, summary: 's', price: null, raw: {}, promptVersionId,
    });
    await db.sql`UPDATE posts SET status = 'failed' WHERE reddit_id = 't3_t'`;

    await requeuePost(db.sql, 't3_t');

    const [row] = await db.sql<Array<{status: string}>>`
      SELECT status FROM posts WHERE reddit_id = 't3_t'`;
    expect(row?.status).toBe('target');
  });

  it('backs a retry off exponentially', async () => {
    await insertNewPosts(db.sql, [samplePost({redditId: 't3_r'})]);
    await claimPosts(db.sql, 'worker-1', 'new', 1);
    await releasePostFailure(db.sql, 'worker-1', 't3_r');

    const [row] = await db.sql<Array<{secs: number}>>`
      SELECT EXTRACT(EPOCH FROM next_retry_at - NOW())::float AS secs
        FROM posts WHERE reddit_id = 't3_r'`;
    expect(row?.secs).toBeGreaterThan(25);
    expect(row?.secs).toBeLessThan(35);
  });
});

describe('shutdown', () => {
  it('hands back everything this worker held so a restart resumes immediately', async () => {
    await db.sql`INSERT INTO subreddits (name) VALUES ('a')`;
    await insertNewPosts(db.sql, [samplePost({redditId: 't3_s'})]);
    await claimDueSubreddits(db.sql, 'worker-1');
    await claimPosts(db.sql, 'worker-1', 'new', 1);

    await releaseAllClaims(db.sql, 'worker-1');

    expect(await claimDueSubreddits(db.sql, 'worker-2')).toHaveLength(1);
    expect(await claimPosts(db.sql, 'worker-2', 'new', 1)).toHaveLength(1);
  });
});
