// The PM tracer: counting buyers on a real comment feed, and the lease that
// keeps the work on one worker.

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {holdLease, insertNewPosts, releaseAllClaims} from '../src/claims.ts';
import {createLogger} from '../src/logger.ts';
import {countPms, Tracer, TRACER_LEASE} from '../src/loops/trace.ts';
import {RedditPacer} from '../src/pacing.ts';
import {parseComments} from '../src/reddit.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

const here = dirname(fileURLToPath(import.meta.url));
// r/hardwareswap t3_1xetlvn, captured 2026-10-26: hwsbot plus four buyers.
const fixture = readFileSync(join(here, 'fixtures', 'comments-feed.xml'), 'utf8');

describe('countPms', () => {
  it('counts the buyers on a captured thread and skips the swap bot', () => {
    const comments = parseComments(fixture);
    expect(comments).toHaveLength(5);
    expect(countPms(comments, 'Ok-Advance2839')).toEqual({comments: 5, pms: 4});
  });

  it('counts each buyer once, and never the seller', () => {
    expect(countPms([
      {author: 'buyer', text: 'PM'},
      {author: 'buyer', text: 'pm\'d again'},
      {author: 'Seller', text: 'Replied to all PMs'},
      {author: 'other', text: 'Chat sent!'},
      {author: 'third', text: 'PM’d'},
      {author: 'fourth', text: 'sent you a message'},
      {author: 'lurker', text: 'Great price, good luck with the sale'},
      {author: 'AutoModerator', text: 'Please PM, do not comment prices'},
    ], 'seller')).toEqual({comments: 8, pms: 4});
  });

  it('does not read a time of day as a PM', () => {
    expect(countPms([{author: 'a', text: 'Can pick up after 5pm'}], 'seller').pms).toBe(0);
  });
});

describe('Tracer', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb('trace');
  }, 60_000);

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.sql`DELETE FROM posts`;
    await db.sql`DELETE FROM loop_leases`;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function tracer(workerId: string): Tracer {
    return new Tracer({
      sql: db.sql,
      workerId,
      userAgent: 'test',
      pacer: new RedditPacer({maxRpm: 1000}),
      logger: createLogger(workerId, 'error'),
    });
  }

  async function seed(redditId: string, hoursAgo: number): Promise<void> {
    await insertNewPosts(db.sql, [{
      redditId,
      subreddit: 'hardwareswap',
      title: '[USA-WA] [H] Samsung 990 PRO 4TB [W] PayPal',
      selftext: '',
      author: 'Ok-Advance2839',
      flair: null,
      url: `https://www.reddit.com/r/hardwareswap/comments/${redditId.slice(3)}/x/`,
      postedAt: new Date(Date.now() - hoursAgo * 3600_000),
    }]);
  }

  async function countsOf(redditId: string) {
    const [row] = await db.sql<Array<{
      comments_checked_at: Date | null; comment_count: number | null; pm_count: number | null;
    }>>`SELECT comments_checked_at, comment_count, pm_count FROM posts WHERE reddit_id = ${redditId}`;
    return row!;
  }

  it('counts a day-old post once and leaves fresher and older ones alone', async () => {
    await seed('t3_day', 30);
    await seed('t3_fresh', 3);
    await seed('t3_old', 24 * 10);
    const spy = vi.fn().mockResolvedValue(new Response(fixture, {status: 200}));
    vi.stubGlobal('fetch', spy);

    expect(await tracer('w1').once()).toBe(true);
    expect(await tracer('w1').once()).toBe(false);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toBe('https://www.reddit.com/r/hardwareswap/comments/day/x/.rss?limit=500');
    expect(await countsOf('t3_day')).toMatchObject({comment_count: 5, pm_count: 4});
    expect((await countsOf('t3_fresh')).comments_checked_at).toBeNull();
    expect((await countsOf('t3_old')).comments_checked_at).toBeNull();
  });

  it('lets only the lease holder trace', async () => {
    await seed('t3_day', 30);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(fixture, {status: 200})));
    await holdLease(db.sql, TRACER_LEASE, 'w1', 600);

    expect(await tracer('w2').once()).toBe(false);
    expect((await countsOf('t3_day')).comments_checked_at).toBeNull();
  });

  it('hands the lease over once its holder lets it go', async () => {
    await holdLease(db.sql, TRACER_LEASE, 'w1', 600);
    expect(await holdLease(db.sql, TRACER_LEASE, 'w2', 600)).toBe(false);

    await releaseAllClaims(db.sql, 'w1');
    expect(await holdLease(db.sql, TRACER_LEASE, 'w2', 600)).toBe(true);
  });

  it('takes over a lease that lapsed', async () => {
    await db.sql`INSERT INTO loop_leases VALUES (${TRACER_LEASE}, 'w1', NOW() - INTERVAL '1 second')`;
    expect(await holdLease(db.sql, TRACER_LEASE, 'w2', 600)).toBe(true);
  });

  it('gives the lease up when Reddit blocks it, and leaves the post for later', async () => {
    await seed('t3_day', 30);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {status: 429})));

    expect(await tracer('w1').once()).toBe(false);

    expect((await countsOf('t3_day')).comments_checked_at).toBeNull();
    expect(await db.sql`SELECT 1 FROM loop_leases`).toHaveLength(0);
  });

  it('marks a removed post checked with no counts, so it is not asked for again', async () => {
    await seed('t3_day', 30);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', {status: 404})));

    expect(await tracer('w1').once()).toBe(true);

    expect(await countsOf('t3_day')).toMatchObject({comment_count: null, pm_count: null});
    expect((await countsOf('t3_day')).comments_checked_at).not.toBeNull();
  });
});
