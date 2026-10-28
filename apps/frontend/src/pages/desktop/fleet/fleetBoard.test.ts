import { describe, expect, it } from 'vitest';
import type { ReviewStatsDay } from '../../../lib/coordinator';
import type { FleetCity, FleetTask } from '../../../lib/fleet';
import { CITIES, HITS, HOSTS, NOW, RELEASE, SLOTS, STATS, TASKS, WORKERS } from './fixtures';
import {
  alertsByCity, averageTaskSeconds, beltAxis, beltLeft, beltRow, beltSummary, budgetTone, cityBucket, cityStanding, daySeries, dueIn, dueLabel,
  easternClock, filterCities, filterTasks, funnelCounts, funnelGaps, funnelHeadline, hostRunning, isQuarantined, isSlug,
  lastDoneSearch, leaseLive, liveness, logByItem, maskUid, nextDue, niceTop, openSearch, releaseSummary, rollProgress, hostLag, imageVersion, roundStartPreview,
  slotLease, sortTasks, spanLabel, utcDayStart, withCityNames, workersBusy,
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

describe('the belt', () => {
  it('places an instant on the 24-hour window', () => {
    expect(beltLeft(NOW, NOW)).toBe(50);
    expect(beltLeft(NOW - 12 * 3_600_000, NOW)).toBe(0);
    expect(beltLeft(min(6 * 60), NOW)).toBe(75);
  });
  it('buckets one item’s tasks by state and quarter hour', () => {
    const row = beltRow(TASKS, 'server_ram', NOW);
    expect(row.counts).toEqual({ done: 1, leased: 1, due: 1, later: 1 });
    // nyc's search finished 240 min ago: bucket -16, left of now.
    const done = row.marks.find(m => m.kind === 'done')!;
    expect(done.key).toBe('d-16');
    expect(done.tasks.map(x => x.id)).toEqual([190]);
    expect(done.left).toBeLessThan(50);
    // houston is leased: just right of now.
    expect(row.marks.find(m => m.kind === 'leased')!.left).toBe(50.5);
    // philly is due in 15 min: inside the next hour, so amber.
    const soon = row.marks.find(m => m.kind === 'soon')!;
    expect(soon.tasks.map(x => x.id)).toEqual([207]);
    expect(soon.left).toBeGreaterThan(50);
    // denver is 45 min overdue: the wall, not a mark.
    expect(row.due.map(x => x.id)).toEqual([203]);
    // boise's slug check is not a city-item.
    expect(row.marks.flatMap(m => m.tasks).map(x => x.id)).not.toContain(209);
  });
  it('leaves out what is beyond the window on either side', () => {
    const row = beltRow(TASKS, 'enterprise_ssd', NOW);
    // nyc's enterprise_ssd task is due in 21 h: not on the belt, not counted.
    expect(row.counts.later).toBe(1);   // houston's, in 3 h
    expect(row.marks.find(m => m.kind === 'later')!.tasks.map(x => x.id)).toEqual([202]);
    const old: FleetTask = { ...TASKS[8], item: 'enterprise_ssd', done_at: min(-13 * 60) };
    expect(beltRow([old], 'enterprise_ssd', NOW).counts.done).toBe(0);
  });
  it('puts a manual task first in the due stack', () => {
    const manual: FleetTask = { ...TASKS[2], id: 999, priority: 100, reason: 'manual', due_at: min(-1) };
    expect(beltRow([...TASKS, manual], 'server_ram', NOW).due.map(x => x.id)).toEqual([999, 203]);
  });
  it('ticks every third Eastern hour, clear of the edges and of now', () => {
    const axis = beltAxis(NOW, 'en-US');
    // 14:30 EDT: every third hour from 3 AM to 12 AM; 3 PM sits under the now label and 12 AM/3 AM at the edges are kept only when inside.
    expect(axis.map(a => a.label)).toEqual(['3 AM', '6 AM', '9 AM', '12 PM', '6 PM', '9 PM', '12 AM']);
    for (const a of axis) {
      expect(a.left).toBeGreaterThan(1);
      expect(a.left).toBeLessThan(99);
      expect(Math.abs(a.left - 50)).toBeGreaterThanOrEqual(5);
    }
  });
  it('measures the average task from today’s finished searches', () => {
    // 412, 290 and 500 seconds today.
    expect(averageTaskSeconds(TASKS, NOW)).toBe(401);
    expect(averageTaskSeconds([], NOW)).toBe(360);
    const yesterday: FleetTask = { ...TASKS[8], done_at: '2026-10-23T12:00:00Z' };
    expect(averageTaskSeconds([yesterday], NOW)).toBe(360);
  });
  it('counts the workers that can take a task, busy and idle', () => {
    // homelab-1 idle, homelab-2 session expired, homelab-3 busy, homelab-4 degraded but idle, worker-60-14-1 busy.
    expect(workersBusy(WORKERS, NOW)).toEqual({ busy: 2, idle: 2 });
    expect(workersBusy([{ ...WORKERS[0], last_heartbeat_at: min(-30) }], NOW)).toEqual({ busy: 0, idle: 0 });
  });
  it('sums the rows into the sentence’s numbers', () => {
    const rows = ['server_ram', 'enterprise_ssd'].map(item => beltRow(TASKS, item, NOW));
    const s = beltSummary(rows, { busy: 2, idle: 1 }, 360);
    expect(s).toMatchObject({ done: 3, leased: 2, due: 2, later: 2, busy: 2, idle: 1, avgSeconds: 360 });
    // Two due at six minutes each over three hands: four minutes.
    expect(s.clearMinutes).toBe(4);
    expect(beltSummary(rows, { busy: 0, idle: 0 }, 360).clearMinutes).toBe(12);
  });
});

describe('the city log', () => {
  it('groups per item: the open task, then the last two finished', () => {
    const logs = TASKS.filter(x => x.city === 'houston').map(x => ({ ...x, events: [] }));
    const groups = logByItem(logs, ['server_ram', 'enterprise_ssd']);
    expect(groups.map(g => [g.item, g.tasks.map(x => x.id)])).toEqual([
      ['server_ram', [201]],
      ['enterprise_ssd', [202, 192]],
    ]);
  });
});

describe('cities tab', () => {
  it('buckets a city for the legend', () => {
    expect(cityBucket(CITIES[0])).toBe('enabled');
    expect(cityBucket(CITIES[1])).toBe('enabled');
    expect(cityBucket(CITIES[4])).toBe('verifying');
    expect(cityBucket(CITIES[5])).toBe('disabled');
  });
  it('sorts verifying first, then filters by bucket, region and text', () => {
    expect(filterCities(CITIES, { bucket: 'all', region: '', q: '' }).map(c => c.slug))
      .toEqual(['boise', 'denver', 'houston', 'nyc', 'philly', 'tulsa']);
    expect(filterCities(CITIES, { bucket: 'enabled', region: 'northeast', q: '' }).map(c => c.slug)).toEqual(['nyc', 'philly']);
    expect(filterCities(CITIES, { bucket: 'all', region: '', q: 'HOU' }).map(c => c.slug)).toEqual(['houston']);
  });
  it('finds the newest finished search of a city-item', () => {
    expect(lastDoneSearch(TASKS, 'nyc', 'server_ram')?.id).toBe(190);
    expect(lastDoneSearch(TASKS, 'houston', 'server_ram')).toBeNull();
  });
});

describe('analysis', () => {
  it('sums the stage counters over the range, today included', () => {
    expect(funnelCounts(STATS, 1, NOW)).toMatchObject({ search: 255, cards: 13865, ai: 1281, alert: 9 });
    expect(funnelCounts(STATS, 7, NOW)).toMatchObject({ search: 255 + 240 + 250, ai: 1281 + 1300 + 1250, alert: 9 + 8 + 7 });
    expect(funnelCounts(STATS, 14, NOW).search).toBe(255 + 240 + 250 + 230);
    expect(funnelCounts(null, 1, NOW)).toEqual({});
  });
  it('falls back to reviewed and alerted on rows without the funnel counters', () => {
    const old: ReviewStatsDay[] = [{ day: '2026-10-24', reviewed: 10, alerted: 1 }, { day: '2026-10-23', reviewed: 20, alerted: 2 }];
    expect(funnelCounts(old, 7, NOW)).toEqual({ ai: 30, alert: 3 });
  });
  it('reads the pass rate between stages, cards per search as a ratio', () => {
    const gaps = funnelGaps(funnelCounts(STATS, 1, NOW));
    expect(gaps[0]).toEqual({ kind: 'ratio', value: 54, drop: false });
    expect(gaps[1]).toEqual({ kind: 'pct', value: 44.6, drop: true });
    expect(gaps[4]).toEqual({ kind: 'pct', value: 98, drop: false });
    expect(funnelGaps({ ai: 3, alert: 1 })[0]).toEqual({ kind: 'ratio', value: null, drop: false });
  });
  it('works out the headline ratios', () => {
    const h = funnelHeadline(funnelCounts(STATS, 1, NOW))!;
    expect(h).toMatchObject({ cards: 13865, searches: 255, reviews: 1281, alerts: 9, cardsPerAlert: 1541, reviewsPerAlert: 142, titleDrop: 55, modelDrop: 99 });
    expect(funnelHeadline({ ai: 5, alert: 0 })!.cardsPerAlert).toBeNull();
    expect(funnelHeadline({})).toBeNull();
  });
  it('fills a day series with zeros and sums it', () => {
    const s = daySeries(STATS, 'alerted', 14, NOW);
    expect(s.points.length).toBe(14);
    expect(s.points[13]).toEqual({ day: '2026-10-24', value: 9, today: true });
    expect(s.points[0]).toEqual({ day: '2026-10-11', value: 0, today: false });
    expect(s.total).toBe(9 + 8 + 7 + 6);
    expect(s.max).toBe(9);
    // The full-day average leaves today out.
    expect(s.fullDayAverage).toBe(Math.round(21 / 13));
  });
  it('picks a round top for the gridlines', () => {
    expect(niceTop(0)).toBe(1);
    expect(niceTop(9)).toBe(10);
    expect(niceTop(1407)).toBe(2000);
    expect(niceTop(13)).toBe(20);
  });
  it('groups alerts by city with the fleet’s reviews', () => {
    const rows = alertsByCity(HITS, TASKS, CITIES);
    expect(rows.map(r => [r.slug, r.alerts])).toEqual([['houston', 3], ['nyc', 2]]);
    expect(rows[0]).toMatchObject({ name: 'Houston, TX', region: 'south', reviewed: 5, lastDay: '2026-10-24' });
    expect(rows[0].rate).toBeNull(); // Coordinator alerts include searches outside the ERP task history.
    const matched = alertsByCity(HITS, TASKS.map(t => t.id === 192 ? { ...t, result: { ...t.result, alerted: 3 } } : t), CITIES);
    expect(matched[0].rate).toBeCloseTo(0.6);
    expect(rows[1]).toMatchObject({ reviewed: 12 });
    // An unknown slug is still a row, by its slug.
    expect(alertsByCity([{ day: '2026-10-24', priority: null, item_name: null, search_city: 'nowhere', sent: 1, hit: 0 }], [], [])[0])
      .toMatchObject({ slug: 'nowhere', name: 'nowhere', region: null, reviewed: null, rate: null });
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
    expect(rollProgress(HOSTS[0], RELEASE)).toEqual({ onTarget: 2, total: 4, replacing: 'homelab-3' });
    expect(rollProgress(HOSTS[1], RELEASE)).toBeNull();
    expect(rollProgress(HOSTS[2], RELEASE)).toBeNull();
  });
  it('draws no roll without a rolling release, even with workers behind', () => {
    expect(rollProgress(HOSTS[0], null)).toBeNull();
    expect(rollProgress(HOSTS[0], { ...RELEASE, state: 'done' })).toBeNull();
    expect(rollProgress(HOSTS[0], { ...RELEASE, state: 'failed' })).toBeNull();
  });
  it('names the workers left on an older image and what new ones start on', () => {
    expect(hostLag(HOSTS[0])).toEqual({ behind: 2, versions: ['0.13.9'], target: '0.14.0' });
    expect(hostLag(HOSTS[1])).toBeNull();
    expect(hostLag(HOSTS[2])).toBeNull();
    const mixed = { ...HOSTS[0], report: { version: '1', containers: [
      { worker_id: 'a', image: 'ghcr.io/x/w:0.9.10', state: 'running', started_at: null },
      { worker_id: 'b', image: 'ghcr.io/x/w:0.9.2', state: 'exited', started_at: null },
      { worker_id: 'c', image: 'ghcr.io/x/w:0.9.2', state: 'running', started_at: null },
    ] } };
    expect(hostLag(mixed)).toEqual({ behind: 3, versions: ['0.9.2', '0.9.10'], target: '0.14.0' });
    expect(hostLag({ ...HOSTS[0], desired: { ...HOSTS[0].desired, image: '' } })).toBeNull();
  });
  it('reads an image tag as its version', () => {
    expect(imageVersion('ghcr.io/jinhuw/aimm-recycle:0.14.6')).toBe('0.14.6');
    expect(imageVersion('localhost:5000/w:1.2')).toBe('1.2');
    expect(imageVersion('localhost:5000/w')).toBe('localhost:5000/w');
    expect(imageVersion('ghcr.io/x/w@sha256:abc')).toBe('ghcr.io/x/w@sha256:abc');
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
  it('keeps future searches out of the Due filter', () => {
    expect(filterTasks(TASKS, { state: 'ready', item: '', q: '' }, NOW).map(x => x.id)).toEqual([203, 204, 209]);
  });
  const named = withCityNames(TASKS, CITIES);
  it('names each task’s city from the city list', () => {
    expect(named[0].city_name).toBe('Houston, TX');
    expect(withCityNames([{ ...TASKS[0], city: 'gone' }], CITIES)[0].city_name).toBeNull();
  });
  it('filters by state, item and one box over the city, worker and account', () => {
    expect(filterTasks(TASKS, { state: 'leased', item: '', q: '' }).map(x => x.id)).toEqual([201, 208]);
    expect(filterTasks(named, { state: '', item: 'enterprise_ssd', q: 'NEW YORK' }).map(x => x.id)).toEqual([206, 191]);
    expect(filterTasks(TASKS, { state: '', item: '', q: 'homelab-1' }).map(x => x.id)).toEqual([190, 191]);
    expect(filterTasks(TASKS, { state: '', item: '', q: 'account 31' }).map(x => x.id)).toEqual([208]);
  });
  it('sorts running first, then due, then finished, then waiting for later', () => {
    const ids = sortTasks(TASKS, NOW).map(x => x.id);
    expect(ids.slice(0, 2)).toEqual([208, 201]);              // leased, newest lease first
    expect(ids.slice(2, 5)).toEqual([209, 204, 203]);         // due now, newest due first
    expect(ids[ids.length - 1]).toBe(207);                    // the soonest waiting-for-later task is last
    expect(ids.indexOf(190)).toBeLessThan(ids.indexOf(206));  // finished before waiting-for-later
  });
});
