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

  it('sums finished searches per UTC day, from the first day of the window', async () => {
    await task('2026-10-28T00:10:00Z', 'done', { cards: 120, opened: 50, reviewed: 22, alerted: 1, seconds: 900 });
    await task('2026-10-28T14:00:00Z', 'done', { cards: 80, opened: 30, reviewed: 10, alerted: 0 });
    await task('2026-10-27T23:59:00Z', 'done', { cards: 5, opened: 1, reviewed: 1, alerted: 0 });
    // Before the window, not a search, not finished: none of them counts.
    await task('2026-10-26T23:59:00Z', 'done', { cards: 999 });
    await task('2026-10-28T10:00:00Z', 'done', { cards: 999 }, 'verify-slug');
    await task(null, 'leased', null);

    expect(await funnelDays(getTestDb(), 2, NOW)).toEqual([
      { day: '2026-10-27', searches: 1, cards: 5, opened: 1, reviewed: 1, alerted: 0 },
      { day: '2026-10-28', searches: 2, cards: 200, opened: 80, reviewed: 32, alerted: 1 },
    ]);
  });

  it('counts a search whose result is missing or malformed, and none of its numbers', async () => {
    await task('2026-10-28T09:00:00Z', 'done', null);
    await task('2026-10-28T09:30:00Z', 'done', { cards: 'many', stopped: true });
    expect(await funnelDays(getTestDb(), 1, NOW)).toEqual([
      { day: '2026-10-28', searches: 2, cards: 0, opened: 0, reviewed: 0, alerted: 0 },
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
