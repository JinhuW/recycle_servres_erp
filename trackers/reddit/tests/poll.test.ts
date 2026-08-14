// End-to-end-ish tests for the poll loop: real Postgres coordination, stubbed
// Reddit. These cover the properties the whole fleet depends on — one request
// per batch, no duplicate work, and correct behaviour when Reddit blocks us.

import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {createLogger} from '../src/logger.ts';
import {pollOnce, type PollDeps} from '../src/loops/poll.ts';
import {RedditPacer} from '../src/pacing.ts';
import {SettingsStore} from '../src/settings.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'new-listing.xml'), 'utf8');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb('poll');
}, 60_000);

afterAll(async () => {
  await db.drop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.sql`DELETE FROM posts`;
  await db.sql`DELETE FROM subreddits`;
  await db.sql`INSERT INTO subreddits (name) VALUES
    ('homelab'), ('hardwareswap'), ('homelabsales')`;
});

function deps(workerId = 'worker-1'): PollDeps {
  return {
    sql: db.sql,
    workerId,
    userAgent: 'test-agent',
    // No real waiting: the pacer's own spacing is covered in pacing.test.ts.
    pacer: new RedditPacer({maxRpm: 60_000, sleep: async () => {}}),
    settings: new SettingsStore(db.sql, 0),
    logger: createLogger(workerId, 'error'),
  };
}

/**
 * Rewrites every entry's timestamp. The captured fixture ages as the repo does,
 * so tests state the age they need rather than depending on capture date.
 */
function fixtureAged(hoursAgo: number): string {
  const stamp = new Date(Date.now() - hoursAgo * 3600_000)
    .toISOString()
    .replace(/\.\d+Z$/, '+00:00');
  return fixture.replace(/<published>[^<]+<\/published>/g, `<published>${stamp}</published>`);
}

const freshFixture = (): string => fixtureAged(0);

function stubFeed(body: string, init: ResponseInit = {status: 200}) {
  const spy = vi.fn().mockResolvedValue(new Response(body, init));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('pollOnce', () => {
  it('fetches every due subreddit in a single request', async () => {
    const spy = stubFeed(freshFixture());

    await pollOnce(deps());

    expect(spy).toHaveBeenCalledTimes(1);
    const url = spy.mock.calls[0]![0] as string;
    expect(url).toContain('homelab+hardwareswap+homelabsales');
    expect(url).toContain('limit=100');
  });

  it('records the fetched posts for evaluation', async () => {
    stubFeed(freshFixture());

    expect(await pollOnce(deps())).toBe(true);

    const [row] = await db.sql<Array<{count: string}>>`
      SELECT COUNT(*)::text AS count FROM posts WHERE status = 'new'`;
    expect(Number(row?.count)).toBe(9);
  });

  it('does nothing when no subreddit is due', async () => {
    await db.sql`UPDATE subreddits SET next_poll_at = NOW() + INTERVAL '10 minutes'`;
    const spy = stubFeed(freshFixture());

    expect(await pollOnce(deps())).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('schedules the next poll and releases the claim on success', async () => {
    stubFeed(freshFixture());

    await pollOnce(deps());

    const rows = await db.sql<Array<{claimed_by: string | null; due_in: number}>>`
      SELECT claimed_by, EXTRACT(EPOCH FROM next_poll_at - NOW())::float AS due_in
        FROM subreddits`;
    for (const row of rows) {
      expect(row.claimed_by).toBeNull();
      expect(row.due_in).toBeGreaterThan(60);
    }
  });

  it('does not re-record posts another worker already saw', async () => {
    stubFeed(freshFixture());
    await pollOnce(deps('worker-1'));
    await db.sql`UPDATE subreddits SET next_poll_at = NOW()`;

    stubFeed(freshFixture());
    await pollOnce(deps('worker-2'));

    const [row] = await db.sql<Array<{count: string}>>`
      SELECT COUNT(*)::text AS count FROM posts`;
    expect(Number(row?.count)).toBe(9);
  });

  it('leaves nothing for a second worker while the first holds the claim', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      await gate;
      return new Response(freshFixture(), {status: 200});
    }));

    const first = pollOnce(deps('worker-1'));
    await new Promise((r) => setTimeout(r, 50));
    const secondResult = await pollOnce(deps('worker-2'));
    release();
    await first;

    expect(secondResult).toBe(false);
  });

  it('drops posts older than the configured window', async () => {
    stubFeed(fixtureAged(48));
    await db.sql`UPDATE settings SET value = to_jsonb(24) WHERE key = 'max_post_age_hours'`;

    await pollOnce(deps());

    const [row] = await db.sql<Array<{count: string}>>`
      SELECT COUNT(*)::text AS count FROM posts`;
    expect(Number(row?.count)).toBe(0);
  });

  it('keeps posts inside the configured window', async () => {
    stubFeed(fixtureAged(2));
    await db.sql`UPDATE settings SET value = to_jsonb(24) WHERE key = 'max_post_age_hours'`;

    await pollOnce(deps());

    const [row] = await db.sql<Array<{count: string}>>`
      SELECT COUNT(*)::text AS count FROM posts`;
    expect(Number(row?.count)).toBe(9);
  });

  it('backs off and reschedules when Reddit rate limits us', async () => {
    stubFeed('', {status: 429, headers: {'x-ratelimit-reset': '40'}});
    const d = deps();

    expect(await pollOnce(d)).toBe(false);

    expect(d.pacer.waitMs()).toBeGreaterThan(30_000);
    const [row] = await db.sql<Array<{last_status: string; claimed_by: string | null}>>`
      SELECT last_status, claimed_by FROM subreddits LIMIT 1`;
    expect(row?.last_status).toBe('http_429');
    expect(row?.claimed_by).toBeNull();
  });

  it('treats a 403 block page as a transient block, not a dead subreddit', async () => {
    stubFeed('<body class=theme-beta>blocked</body>', {status: 403});
    const d = deps();

    expect(await pollOnce(d)).toBe(false);

    expect(d.pacer.waitMs()).toBeGreaterThan(0);
    const [row] = await db.sql<Array<{last_status: string; consecutive_errors: number}>>`
      SELECT last_status, consecutive_errors FROM subreddits LIMIT 1`;
    expect(row?.last_status).toBe('http_403');
    expect(row?.consecutive_errors).toBe(1);
  });

  it('applies the rate-limit budget Reddit reports even on success', async () => {
    stubFeed(freshFixture(), {
      status: 200,
      headers: {'x-ratelimit-remaining': '0.0', 'x-ratelimit-reset': '40'},
    });
    const d = deps();

    await pollOnce(d);

    expect(d.pacer.waitMs()).toBeGreaterThan(30_000);
  });

  it('reschedules with backoff after a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    expect(await pollOnce(deps())).toBe(false);

    const [row] = await db.sql<Array<{last_status: string; due_in: number}>>`
      SELECT last_status, EXTRACT(EPOCH FROM next_poll_at - NOW())::float AS due_in
        FROM subreddits LIMIT 1`;
    expect(row?.last_status).toBe('socket hang up');
    expect(row?.due_in).toBeGreaterThan(90);
  });

  it('ignores posts from a subreddit it did not claim', async () => {
    await db.sql`DELETE FROM subreddits WHERE name IN ('hardwareswap', 'homelabsales')`;
    stubFeed(freshFixture());

    await pollOnce(deps());

    const rows = await db.sql<Array<{subreddit: string}>>`
      SELECT DISTINCT subreddit FROM posts`;
    expect(rows.map((r) => r.subreddit)).toEqual(['homelab']);
  });
});
