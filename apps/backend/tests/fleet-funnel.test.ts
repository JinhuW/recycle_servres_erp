import { beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, resetDb } from './helpers/db';
import { funnelDays, readFunnelDays } from '../src/fleet/tasks';

// The Analysis funnel's daily sums over finished searches, with a pinned clock.

const NOW = new Date('2026-10-28T15:00:00Z');

async function task(done: string | null, state: string, result: unknown, kind = 'search') {
  const db = getTestDb();
  await db`
    INSERT INTO fleet_tasks (city, item, kind, due_at, state, done_at, result)
    VALUES ('houston', 'server_ram', ${kind}, ${done ?? NOW.toISOString()}, ${state}, ${done},
            ${result === null ? null : db.json(result as never)})`;
}

describe('funnelDays', () => {
  beforeEach(async () => {
    await resetDb();
    const db = getTestDb();
    await db`INSERT INTO fleet_cities (slug, name, enabled, verified_at, verified_as) VALUES ('houston', 'Houston', TRUE, ${NOW}, 'imported')`;
    await db`INSERT INTO fleet_items (name, phrases) VALUES ('server_ram', '["x"]')`;
  });

  it('sums finished searches per Eastern day, from the first day of the window', async () => {
    // 00:10Z on the 28th is 20:10 Eastern on the 27th.
    await task('2026-10-28T00:10:00Z', 'done', { cards: 120, opened: 50, reviewed: 22, alerted: 1, seconds: 900 });
    await task('2026-10-28T14:00:00Z', 'done', { cards: 80, opened: 30, reviewed: 10, alerted: 0 });
    await task('2026-10-27T04:00:00Z', 'done', { cards: 5, opened: 1, reviewed: 1, alerted: 0 });
    // Before the window (23:59 Eastern on the 26th), not a search, not
    // finished: none of them counts.
    await task('2026-10-27T03:59:00Z', 'done', { cards: 999 });
    await task('2026-10-28T10:00:00Z', 'done', { cards: 999 }, 'verify-slug');
    await task(null, 'leased', null);

    expect(await funnelDays(getTestDb(), 2, NOW)).toEqual([
      { day: '2026-10-27', searches: 2, cards: 125, opened: 51, reviewed: 23, alerted: 1, title_pass: null, keyword_pass: null, fresh: null, passed: null, withheld: null, counted: 0, carded: 2 },
      { day: '2026-10-28', searches: 1, cards: 80, opened: 30, reviewed: 10, alerted: 0, title_pass: null, keyword_pass: null, fresh: null, passed: null, withheld: null, counted: 0, carded: 1 },
    ]);
  });

  it('keeps the 25-hour day DST ends on whole', async () => {
    // Clocks fall back at 06:00Z on Nov 1, so that day runs 04:00Z to 05:00Z.
    await task('2026-11-01T03:30:00Z', 'done', { cards: 999 });
    await task('2026-11-01T04:30:00Z', 'done', { cards: 1 });
    await task('2026-11-02T04:30:00Z', 'done', { cards: 2 });
    await task('2026-11-02T05:30:00Z', 'done', { cards: 4 });
    expect(await funnelDays(getTestDb(), 2, new Date('2026-11-02T15:00:00Z'))).toMatchObject([
      { day: '2026-11-01', searches: 2, cards: 3 },
      { day: '2026-11-02', searches: 1, cards: 4 },
    ]);
  });

  it('sums the later stages over the searches that counted them, and says how many of the day\'s did', async () => {
    const full = { cards: 100, title_pass: 30, opened: 20, keyword_pass: 12, fresh: 10, reviewed: 8, passed: 3, withheld: 3, alerted: 0 };
    await task('2026-10-28T08:00:00Z', 'done', full);
    await task('2026-10-28T09:00:00Z', 'done', full);
    // A stopped search counted nothing, so it does not make the day partial.
    await task('2026-10-28T09:30:00Z', 'done', { stopped: true });
    // An older worker adds its four counts and nothing else; the newer one's
    // still count, over one of the day's two searches.
    await task('2026-10-27T09:00:00Z', 'done', full);
    await task('2026-10-27T10:00:00Z', 'done', { cards: 50, opened: 5, reviewed: 2, alerted: 0 });

    expect(await funnelDays(getTestDb(), 2, NOW)).toEqual([
      {
        day: '2026-10-27', searches: 2, cards: 150, title_pass: 30, opened: 25, keyword_pass: 12, fresh: 10,
        reviewed: 10, passed: 3, withheld: 3, alerted: 0, counted: 1, carded: 2,
      },
      {
        day: '2026-10-28', searches: 3, cards: 200, title_pass: 60, opened: 40, keyword_pass: 24, fresh: 20,
        reviewed: 16, passed: 6, withheld: 6, alerted: 0, counted: 2, carded: 2,
      },
    ]);
  });

  it('leaves out a count too large to be a sweep instead of failing the day', async () => {
    await task('2026-10-28T09:00:00Z', 'done', { cards: 100, opened: 10, reviewed: 99999999999, alerted: 1 });
    expect(await funnelDays(getTestDb(), 1, NOW)).toMatchObject([{ day: '2026-10-28', cards: 100, reviewed: 0, alerted: 1 }]);
  });

  it('counts a search whose result is missing or malformed, and none of its numbers', async () => {
    await task('2026-10-28T09:00:00Z', 'done', null);
    await task('2026-10-28T09:30:00Z', 'done', { cards: 'many', stopped: true });
    expect(await funnelDays(getTestDb(), 1, NOW)).toEqual([
      { day: '2026-10-28', searches: 2, cards: 0, opened: 0, reviewed: 0, alerted: 0, title_pass: null, keyword_pass: null, fresh: null, passed: null, withheld: null, counted: 0, carded: 0 },
    ]);
  });
});

describe('readFunnelDays', () => {
  it('defaults to 14 and refuses a window outside 1–92', () => {
    expect(readFunnelDays({})).toBe(14);
    expect(readFunnelDays({ days: '7' })).toBe(7);
    expect(readFunnelDays({ days: '0' })).toMatchObject({ status: 422 });
    expect(readFunnelDays({ days: '93' })).toMatchObject({ status: 422 });
    expect(readFunnelDays({ days: 'x' })).toMatchObject({ status: 422 });
  });
});
