// The Analytics numbers on a small seeded history. The cases are the ones the
// owner asked for: a memory post with 5+ PMs and no good-catch reaction is
// missing, whether it never alerted or alerted and nobody reacted.

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {analytics} from '../src/analytics.ts';
import {ensurePromptVersion} from '../src/prompts.ts';
import {createTestDb, type TestDb} from './helpers/db.ts';

let db: TestDb;
let live: number;
let candidate: number;
const NOW = new Date('2026-10-26T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

beforeAll(async () => {
  db = await createTestDb('analytics');
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.sql`DELETE FROM message_reactions`;
  await db.sql`DELETE FROM alert_messages`;
  await db.sql`DELETE FROM candidate_verdicts`;
  await db.sql`DELETE FROM posts`;
  await db.sql`DELETE FROM prompt_versions`;
  await db.sql`DELETE FROM loop_leases`;
  live = await ensurePromptVersion(db.sql, {model: 'm', systemPrompt: 'live'});
  candidate = await ensurePromptVersion(db.sql, {model: 'm', systemPrompt: 'candidate'});
});

interface Seed {
  id: string;
  title: string;
  status: 'rejected' | 'notified' | 'duplicate';
  postedHoursAgo: number;
  pms?: number;
  subreddit?: string;
  duplicateOf?: string;
  reaction?: string;
}

let nextMessage = 1;

async function seed(p: Seed): Promise<void> {
  const posted = hoursAgo(p.postedHoursAgo);
  const alerted = p.status !== 'rejected';
  await db.sql`
    INSERT INTO posts (reddit_id, subreddit, title, url, posted_at, discovered_at, status, is_target,
                       prompt_version_id, llm_raw, notified_at, duplicate_of,
                       comments_checked_at, comment_count, pm_count)
    VALUES (${p.id}, ${p.subreddit ?? 'hardwareswap'}, ${p.title}, ${`https://reddit.com/${p.id}`},
            ${posted}, ${posted}, ${p.status}, ${alerted}, ${live},
            ${db.sql.json({reasoning: alerted ? 'bulk lot' : 'only 2 modules'})},
            ${p.status === 'notified' ? new Date(posted.getTime() + 10 * 60_000) : null},
            ${p.duplicateOf ?? null},
            ${p.pms === undefined ? null : NOW}, ${p.pms ?? null}, ${p.pms ?? null})`;
  if (p.status === 'notified') {
    const message = nextMessage++;
    await db.sql`INSERT INTO alert_messages (chat_id, message_id, reddit_id, audience)
                 VALUES ('buyers', ${message}, ${p.id}, 'buyers')`;
    if (p.reaction) {
      await db.sql`
        INSERT INTO message_reactions (chat_id, message_id, reactor, emoji, updated_at)
        VALUES ('buyers', ${message}, 'u1', ${db.sql.json([p.reaction])}, NOW())`;
    }
  }
}

const RAM = '[USA-PA] [H] 16x 64GB DDR4 RDIMM [W] PayPal';

describe('analytics', () => {
  it('counts alerts, reactions and time to alert over the window', async () => {
    await seed({id: 't3_good', title: RAM, status: 'notified', postedHoursAgo: 2, reaction: '🔥'});
    await seed({id: 't3_bad', title: RAM, status: 'notified', postedHoursAgo: 3, reaction: '👎'});
    await seed({id: 't3_quiet', title: RAM, status: 'notified', postedHoursAgo: 4});
    await seed({id: 't3_dup', title: RAM, status: 'duplicate', postedHoursAgo: 4, duplicateOf: 't3_quiet'});
    await seed({id: 't3_gpu', title: '[USA-CA] [H] RTX 4090 [W] PayPal', status: 'rejected', postedHoursAgo: 5});
    await seed({id: 't3_old', title: RAM, status: 'notified', postedHoursAgo: 30});

    const a = await analytics(db.sql, {window: '24h', liveHash: '', candidateHash: null, now: NOW});

    expect(a.volume).toMatchObject({posts: 5, judged: 5, memoryPosts: 4, alerts: 3, duplicates: 1});
    expect(a.feedback).toEqual({alerts: 3, good: 1, bad: 1, unreacted: 1});
    expect(a.speed.medianMinutes).toBe(10);
    expect(a.series.bucket).toBe('hour');
    expect(a.series.points).toHaveLength(24);
    expect(a.series.points.reduce((n, p) => n + p.alerts, 0)).toBe(3);
  });

  it('counts a hot memory post with no good reaction as missing, alerted or not', async () => {
    // The demand range is the day before the window, so these are 24-48h old.
    await seed({id: 't3_caught', title: RAM, status: 'notified', postedHoursAgo: 30, pms: 9, reaction: '👍'});
    await seed({id: 't3_ignored', title: RAM, status: 'notified', postedHoursAgo: 31, pms: 6});
    await seed({id: 't3_rejected', title: RAM, status: 'rejected', postedHoursAgo: 32, pms: 12});
    await seed({id: 't3_cool', title: RAM, status: 'rejected', postedHoursAgo: 33, pms: 2});
    await seed({id: 't3_gpu', title: '[USA-CA] [H] RTX 4090 [W] PayPal', status: 'rejected',
                postedHoursAgo: 34, pms: 20});
    await seed({id: 't3_pending', title: RAM, status: 'rejected', postedHoursAgo: 35});

    const a = await analytics(db.sql, {window: '24h', liveHash: '', candidateHash: null, now: NOW});

    expect(a.demand).toMatchObject({
      posts: 6,
      traced: 5,
      memoryTraced: 4,
      hotMemory: 3,
      caught: 1,
      alertedNoReaction: 1,
      notAlerted: 1,
      missing: 2,
    });
    expect(a.missing.map((m) => [m.redditId, m.alerted, m.reasoning])).toEqual([
      ['t3_rejected', false, 'only 2 modules'],
      ['t3_ignored', true, null],
    ]);
    expect(a.hotOther.map((m) => m.redditId)).toEqual(['t3_gpu']);
  });

  it('lets a cross-post copy share the reaction its alerted twin got', async () => {
    await seed({id: 't3_hls', title: RAM, status: 'notified', postedHoursAgo: 30, pms: 7,
                subreddit: 'homelabsales', reaction: '❤'});
    await seed({id: 't3_hws', title: RAM, status: 'duplicate', postedHoursAgo: 30, pms: 8,
                duplicateOf: 't3_hls'});

    const a = await analytics(db.sql, {window: '24h', liveHash: '', candidateHash: null, now: NOW});

    expect(a.demand).toMatchObject({hotMemory: 2, caught: 2, missing: 0});
  });

  it('scores each prompt version, a trial included, on the hot posts it judged', async () => {
    await seed({id: 't3_a', title: RAM, status: 'rejected', postedHoursAgo: 30, pms: 10});
    await seed({id: 't3_b', title: RAM, status: 'notified', postedHoursAgo: 31, pms: 5});
    await db.sql`INSERT INTO candidate_verdicts (reddit_id, prompt_version_id, is_target, summary, reasoning)
                 VALUES ('t3_a', ${candidate}, TRUE, 'x', 'x'), ('t3_b', ${candidate}, TRUE, 'x', 'x')`;
    const [hashes] = await db.sql<Array<{live: string; candidate: string}>>`
      SELECT (SELECT hash FROM prompt_versions WHERE id = ${live}) AS live,
             (SELECT hash FROM prompt_versions WHERE id = ${candidate}) AS candidate`;

    const a = await analytics(db.sql, {
      window: '7d', liveHash: hashes!.live, candidateHash: hashes!.candidate, now: NOW,
    });

    const byRole = Object.fromEntries(a.prompts.map((p) => [p.role, p]));
    expect(byRole['live']).toMatchObject({hotMemoryJudged: 2, hotMemoryFlagged: 1});
    expect(byRole['candidate']).toMatchObject({hotMemoryJudged: 2, hotMemoryFlagged: 2});
    expect(a.series.bucket).toBe('day');
    expect(a.series.points).toHaveLength(7);
  });

  it('breaks the numbers down by subreddit and names the tracer', async () => {
    await seed({id: 't3_a', title: RAM, status: 'rejected', postedHoursAgo: 30, pms: 10});
    await seed({id: 't3_b', title: RAM, status: 'rejected', postedHoursAgo: 30, pms: 0,
                subreddit: 'homelabsales'});
    await db.sql`INSERT INTO loop_leases VALUES ('comment_tracer', 'worker-7', NOW() + INTERVAL '5 minutes')`;

    const a = await analytics(db.sql, {window: '7d', liveHash: '', candidateHash: null, now: NOW});

    expect(a.subreddits.find((s) => s.name === 'hardwareswap')).toMatchObject({
      posts: 1, traced: 1, avgPms: 10, hotMemory: 1, missing: 1,
    });
    expect(a.subreddits.find((s) => s.name === 'homelabsales')).toMatchObject({avgPms: 0, missing: 0});
    expect(a.tracer?.workerId).toBe('worker-7');
  });
});
