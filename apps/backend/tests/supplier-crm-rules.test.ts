// The follow-up rules as pure functions. These encode the business policy —
// who counts as a top seller, when a client has gone quiet, how often to call —
// so they are worth testing without a database in the way.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CRM, tierFor, cadenceFor, healthFor, effectiveGap, dueStateFor, isoDatePlus,
} from '../src/services/supplierCrm';

const S = DEFAULT_CRM;

describe('tier', () => {
  it('splits the book 20 / 30 / 50 by recency-weighted spend', () => {
    expect(tierFor(0, null)).toBe('A');
    expect(tierFor(0.19, null)).toBe('A');
    expect(tierFor(0.2, null)).toBe('B');
    expect(tierFor(0.49, null)).toBe('B');
    expect(tierFor(0.5, null)).toBe('C');
    expect(tierFor(1, null)).toBe('C');
  });

  it('drops anyone under the spend floor to C (pr is null there)', () => {
    expect(tierFor(null, null)).toBe('C');
  });

  it("lets a manager's pin beat the formula", () => {
    expect(tierFor(0.9, 'A')).toBe('A');
    expect(tierFor(0, 'C')).toBe('C');
  });
});

describe('cadence', () => {
  it('follows the tier', () => {
    expect(cadenceFor('A', 'active', null, S)).toBe(14);
    expect(cadenceFor('B', 'active', null, S)).toBe(30);
    expect(cadenceFor('C', 'active', null, S)).toBe(90);
  });

  it('chases a new lead harder than a settled occasional seller', () => {
    expect(cadenceFor('C', 'prospect', null, S)).toBe(21);
    expect(cadenceFor('C', 'prospect', null, S)).toBeLessThan(cadenceFor('C', 'active', null, S));
  });

  it('honours a per-client override over the tier default', () => {
    expect(cadenceFor('A', 'active', 60, S)).toBe(60);
  });
});

describe('health is judged against each client\'s own rhythm', () => {
  const base = { standing: 'active' as const, poCount: 8, cadenceDays: 30 };

  it('a 3-week buyer silent 2 months has gone quiet', () => {
    expect(healthFor({ ...base, daysSinceLastPo: 58, rawGapDays: 21 }, S)).toBe('quiet');
  });

  it('a twice-a-year buyer silent 2 months is fine', () => {
    expect(healthFor({ ...base, daysSinceLastPo: 58, rawGapDays: 120 }, S)).toBe('ok');
  });

  it('past four times the rhythm we have lost touch', () => {
    expect(healthFor({ ...base, daysSinceLastPo: 186, rawGapDays: 26 }, S)).toBe('lost');
  });

  it('is lost after a year however slow their rhythm', () => {
    expect(healthFor({ ...base, daysSinceLastPo: 400, rawGapDays: 180 }, S)).toBe('lost');
  });

  it('a client with no orders is new, not quiet', () => {
    expect(healthFor({ ...base, poCount: 0, daysSinceLastPo: null, rawGapDays: null }, S)).toBe('new');
    expect(healthFor({ ...base, standing: 'prospect', daysSinceLastPo: null, rawGapDays: null }, S)).toBe('new');
  });

  it('falls back to 3x cadence when one order makes a gap unmeasurable', () => {
    // cadence 30 -> assumed rhythm 90 -> quiet past 180
    expect(healthFor({ ...base, poCount: 1, daysSinceLastPo: 100, rawGapDays: null }, S)).toBe('ok');
    expect(healthFor({ ...base, poCount: 1, daysSinceLastPo: 200, rawGapDays: null }, S)).toBe('quiet');
  });
});

describe('gap clamping', () => {
  it('stops two orders in one week flagging them within days', () => {
    // Unclamped, a 2-day rhythm would call them quiet after 4 days. The floor
    // makes the shortest rhythm we will ever measure a week, so the earliest
    // anyone can be flagged is a fortnight.
    expect(effectiveGap(2, 30, S)).toBe(S.gapMinDays);
    const at = (d: number) => healthFor(
      { standing: 'active', poCount: 2, daysSinceLastPo: d, rawGapDays: 2, cadenceDays: 30 }, S);
    expect(at(4)).toBe('ok');
    expect(at(13)).toBe('ok');
    expect(at(20)).toBe('quiet');
  });

  it('still surfaces a once-a-year seller eventually', () => {
    expect(effectiveGap(400, 90, S)).toBe(S.gapMaxDays);
  });
});

describe('due state', () => {
  it('separates late, today, this week and later', () => {
    expect(dueStateFor(-3)).toBe('overdue');
    expect(dueStateFor(0)).toBe('today');
    expect(dueStateFor(7)).toBe('soon');
    expect(dueStateFor(8)).toBe('later');
    expect(dueStateFor(null)).toBe('none');
  });
});

describe('scheduling', () => {
  it('returns a plain date n days out', () => {
    expect(isoDatePlus(14, new Date('2026-08-28T23:30:00Z'))).toBe('2026-09-11');
  });

  it('does not drift across a month boundary', () => {
    expect(isoDatePlus(1, new Date('2026-08-31T12:00:00Z'))).toBe('2026-09-01');
  });
});
