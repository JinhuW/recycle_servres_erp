import { describe, expect, it } from 'vitest';
import type { FleetCity, FleetTask } from '../../../lib/fleet';
import { CITIES, HOSTS, NOW, RELEASE, SLOTS, TASKS } from './fixtures';
import {
  boardCells, budgetTone, cityStanding, countsSentence, dueIn, dueLabel, easternClock, filterTasks, hostRunning, isQuarantined,
  isSlug, leaseLive, liveness, maskUid, nextDue, openSearch, releaseSummary, rollProgress, roundStartPreview, slotLease, sortTasks, spanLabel,
  utcDayStart, withCityNames,
} from './fleetBoard';

// A translator that shows its key and its numbers, so a sentence can be read
// in the assertion without the English dictionary.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')})` : key;

const min = (n: number) => new Date(NOW + n * 60_000).toISOString();

describe('easternClock', () => {
  it('shows a time today as a clock in New York', () => {
    // 18:30 UTC on 2026-10-24 is 14:30 EDT.
    expect(easternClock('2026-10-24T18:30:00Z', 'en-US', NOW)).toBe('02:30 PM');
  });
  it('names the day for another day', () => {
    expect(easternClock('2026-10-22T18:30:00Z', 'en-US', NOW)).toMatch(/Oct 22/);
  });
  it('is empty for nothing or junk', () => {
    expect(easternClock(null, 'en-US', NOW)).toBe('');
    expect(easternClock('nope', 'en-US', NOW)).toBe('');
  });
});

describe('utcDayStart', () => {
  it('is midnight UTC of the day', () => {
    expect(utcDayStart(NOW)).toBe('2026-10-24T00:00:00.000Z');
  });
});

describe('due times', () => {
  it('reads the sign and rounds to minutes', () => {
    expect(dueIn(min(0), NOW)).toEqual({ kind: 'now' });
    expect(dueIn(min(-45), NOW)).toEqual({ kind: 'overdue', minutes: 45 });
    expect(dueIn(min(130), NOW)).toEqual({ kind: 'in', minutes: 130 });
  });
  it('spans read in the unit that fits', () => {
    expect(spanLabel(t, 45)).toBe('fleetSpanMin(n=45)');
    expect(spanLabel(t, 130)).toBe('fleetSpanHours(h=2,m=10)');
    expect(spanLabel(t, 1500)).toBe('fleetSpanDays(d=1,h=1)');
  });
  it('labels a due time', () => {
    expect(dueLabel(t, null, NOW)).toBe('—');
    expect(dueLabel(t, min(0), NOW)).toBe('fleetDueNow');
    expect(dueLabel(t, min(-45), NOW)).toBe('fleetDueOverdue(span=fleetSpanMin(n=45))');
    expect(dueLabel(t, min(15), NOW)).toBe('fleetDueIn(span=fleetSpanMin(n=15))');
  });
});

describe('boardCells', () => {
  it('ranks each city by its state, in board order, then by name', () => {
    const { cells, counts } = boardCells(CITIES, TASKS, 'server_ram', NOW);
    expect(cells.map(c => `${c.slug}:${c.state}`)).toEqual([
      'nyc:done',        // searched today, though its next task waits
      'houston:leased',  // homelab-3 holds it
      'denver:due',      // ready, 45 min overdue
      'philly:later',    // ready in 15 min
      'tulsa:cancelled', // removed today
    ]);
    expect(counts).toEqual({ cities: 5, done: 1, leased: 1, due: 1, later: 1, cancelled: 1 });
  });
  it('carries the time and the worker the state turns on', () => {
    const { cells } = boardCells(CITIES, TASKS, 'server_ram', NOW);
    const leased = cells.find(c => c.slug === 'houston')!;
    expect(leased.by).toBe('homelab-3');
    expect(leased.at).toBe(TASKS[0].lease_expires_at);
    const done = cells.find(c => c.slug === 'nyc')!;
    expect(done.by).toBe('homelab-1');
    expect(done.at).toBe(TASKS[8].done_at);
  });
  it('leaves out a verifying city and a removed city with no task today', () => {
    const { cells } = boardCells(CITIES, [], 'server_ram', NOW);
    expect(cells.map(c => c.slug)).not.toContain('boise');
    expect(cells.map(c => c.slug)).not.toContain('tulsa');
  });
  it('reads an enabled city with nothing open as waiting', () => {
    const bare: FleetCity = { ...CITIES[1], open_tasks: [] };
    const { cells } = boardCells([bare], [], 'server_ram', NOW);
    expect(cells).toEqual([{ slug: 'denver', name: 'Denver, CO', state: 'later', at: null, by: null }]);
  });
  it('does not count a finished slug check as the day’s search', () => {
    const checked: FleetTask = { ...TASKS[13], state: 'done', done_at: min(-1) };
    const boise: FleetCity = { ...CITIES[4], enabled: true, verified_at: min(-1), open_tasks: [] };
    const { cells } = boardCells([boise], [checked], 'server_ram', NOW);
    expect(cells[0].state).toBe('later');
  });
  it('does not count yesterday as done today', () => {
    const yesterday: FleetTask = { ...TASKS[8], done_at: '2026-10-23T23:59:00Z' };
    const nyc: FleetCity = { ...CITIES[2], open_tasks: [] };
    const { cells } = boardCells([nyc], [yesterday], 'server_ram', NOW);
    expect(cells[0].state).toBe('later');
  });
});

describe('countsSentence', () => {
  it('says the round is done when every working city is searched', () => {
    expect(countsSentence(t, { cities: 3, done: 2, leased: 0, due: 0, later: 0, cancelled: 1 })).toBe('fleetBoardDone(n=2).');
  });
  it('lists only the counts that are not zero, then the cancelled ones', () => {
    expect(countsSentence(t, { cities: 5, done: 1, leased: 1, due: 0, later: 2, cancelled: 1 }))
      .toBe('fleetBoardSearched(done=1,n=4), fleetBoardLeased(n=1), fleetBoardLater(n=2). fleetBoardCancelled(n=1)');
  });
  it('has a word for an empty round', () => {
    expect(countsSentence(t, { cities: 1, done: 0, leased: 0, due: 0, later: 0, cancelled: 1 })).toBe('fleetBoardEmpty');
  });
});

describe('roundStartPreview', () => {
  it('counts searches waiting for later, skipping city-items searched within the window', () => {
    const preview = roundStartPreview(CITIES, ['server_ram', 'enterprise_ssd'], 2, NOW);
    // server_ram: nyc (4 h ago) and philly (23 h ago) wait; denver is already due, so the start leaves it.
    expect(preview.server_ram).toEqual({ ready: 2, due: 2, skipped: 0 });
    // enterprise_ssd: houston done 90 min ago is fresh; nyc is not; denver is already due.
    expect(preview.enterprise_ssd).toEqual({ ready: 2, due: 1, skipped: 1 });
  });
  it('a wider window skips more', () => {
    expect(roundStartPreview(CITIES, ['server_ram'], 6, NOW).server_ram).toEqual({ ready: 2, due: 1, skipped: 1 });
  });
});

describe('cities', () => {
  it('reads a city’s standing', () => {
    expect(cityStanding(CITIES[0])).toBe('enabled');
    expect(cityStanding(CITIES[4])).toBe('verifying');
    expect(cityStanding(CITIES[5])).toBe('removed');
    expect(cityStanding({ ...CITIES[0], enabled: false })).toBe('disabled');
  });
  it('finds the soonest open task and the holder', () => {
    expect(nextDue(CITIES[0])).toEqual({ at: TASKS[0].due_at, holder: 'homelab-3' });
    // A city being verified is due when its verify-slug task is.
    expect(nextDue(CITIES[4])).toEqual({ at: TASKS[13].due_at, holder: null });
    expect(nextDue(CITIES[5])).toEqual({ at: null, holder: null });
  });
  it('picks the open search per item and passes over a verify-slug task', () => {
    expect(openSearch(CITIES[0], 'server_ram')?.id).toBe(201);
    expect(openSearch(CITIES[4], 'server_ram')).toBeNull();
    expect(CITIES[4].open_tasks.map(x => x.kind)).toEqual(['verify-slug']);
  });
  it('accepts Marketplace slugs and numeric ids', () => {
    expect(isSlug('houston')).toBe(true);
    expect(isSlug('fort-myers_fl')).toBe(true);
    expect(isSlug('108424279189115')).toBe(true);
    expect(isSlug('Houston')).toBe(false);
    expect(isSlug('-x')).toBe(false);
    expect(isSlug('')).toBe(false);
  });
});

describe('hosts', () => {
  it('counts running containers against the desired count', () => {
    expect(hostRunning(HOSTS[0])).toEqual({ running: 4, desired: 4 });
    expect(hostRunning(HOSTS[1])).toEqual({ running: 1, desired: 2 });
    expect(hostRunning(HOSTS[2])).toEqual({ running: 0, desired: 0 });
  });
  it('follows a roll and is quiet once every container is on the image', () => {
    expect(rollProgress(HOSTS[0])).toEqual({ onTarget: 2, total: 4, replacing: 'homelab-3' });
    expect(rollProgress(HOSTS[1])).toBeNull();
    expect(rollProgress(HOSTS[2])).toBeNull();
  });
  it('sums up the latest release', () => {
    expect(releaseSummary(RELEASE)).toEqual({ upgraded: 3, skipped: 1, replacing: 'homelab-3' });
    expect(releaseSummary({ ...RELEASE, current: null, state: 'done' })).toEqual({ upgraded: 3, skipped: 1, replacing: null });
    expect(releaseSummary(null)).toBeNull();
  });
  it('grades a last-seen time', () => {
    expect(liveness(min(-1), NOW)).toBe('live');
    expect(liveness(min(-7), NOW)).toBe('stale');
    expect(liveness(min(-30), NOW)).toBe('dead');
    expect(liveness(null, NOW)).toBe('never');
  });
});

describe('slots', () => {
  it('masks a uid to its ends', () => {
    expect(maskUid('100012345678901')).toBe('100…901');
    expect(maskUid('12345')).toBe('1…5');
    expect(maskUid(null)).toBe('—');
  });
  it('tones the budget ring', () => {
    expect(budgetTone(0, 360)).toBe('idle');
    expect(budgetTone(100, 360)).toBe('part');
    expect(budgetTone(360, 360)).toBe('full');
  });
  it('reads quarantine and lease against now', () => {
    expect(isQuarantined(SLOTS[3], NOW)).toBe(true);
    expect(isQuarantined(SLOTS[0], NOW)).toBe(false);
    expect(leaseLive(SLOTS[0], NOW)).toBe(true);
    expect(leaseLive(SLOTS[5], NOW)).toBe(false);
    expect(leaseLive(SLOTS[7], NOW)).toBe(false);
  });
  it('tells a parked slot from a free one, though neither has a lease', () => {
    expect(SLOTS[8].lease_expires_at).toBeNull();
    expect(slotLease(SLOTS[8], NOW)).toBe('parked');
    expect(slotLease(SLOTS[7], NOW)).toBe('free');
    expect(slotLease(SLOTS[0], NOW)).toBe('held');
    expect(slotLease(SLOTS[5], NOW)).toBe('lapsed');
  });
});

describe('task table', () => {
  const named = withCityNames(TASKS, CITIES);
  it('names each task’s city from the city list', () => {
    expect(named[0].city_name).toBe('Houston, TX');
    expect(withCityNames([{ ...TASKS[0], city: 'gone' }], CITIES)[0].city_name).toBeNull();
  });
  it('filters by state, item and a case-insensitive city or worker', () => {
    expect(filterTasks(TASKS, { state: 'leased', item: '', city: '', worker: '' }).map(x => x.id)).toEqual([201, 208]);
    expect(filterTasks(named, { state: '', item: 'enterprise_ssd', city: 'NEW YORK', worker: '' }).map(x => x.id)).toEqual([206, 191]);
    expect(filterTasks(TASKS, { state: '', item: '', city: '', worker: 'homelab-1' }).map(x => x.id)).toEqual([190, 191]);
  });
  it('sorts newest activity first', () => {
    const ids = sortTasks(TASKS).map(x => x.id);
    // The furthest-ahead due time leads; the oldest finished task is last.
    expect(ids[0]).toBe(206);
    expect(ids[ids.length - 1]).toBe(170);
  });
});
