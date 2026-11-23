// Calendar dates and day boundaries as the Denver office sees them. The suite
// pins the process zone to Denver so the evening hours, when the UTC date is
// already tomorrow, are exercised whatever zone the machine runs in.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { followUpDate } from './clients';
import { fmtCalendarDayShort, fmtDateShort, localDayKey } from './format';
import { fmtEta } from './shippingList';

// Node re-reads its zone when process.env.TZ is assigned, which stubEnv does.
beforeAll(() => { vi.stubEnv('TZ', 'America/Denver'); });
afterAll(() => { vi.unstubAllEnvs(); });

describe('fmtDateShort', () => {
  it('shows a date-only value as that calendar date', () => {
    expect(fmtDateShort('2026-11-25')).toBe('Nov 25');
  });
  it('still shows an instant in local time', () => {
    // 01:00Z Nov 23 is 18:00 MST Nov 22.
    expect(fmtDateShort('2026-11-23T01:00:00.000Z')).toBe('Nov 22');
    expect(fmtDateShort(new Date('2026-11-23T01:00:00.000Z'))).toBe('Nov 22');
  });
});

describe('fmtCalendarDayShort', () => {
  it('reads a UTC-midnight ETA as its calendar date, as fmtEta does', () => {
    expect(fmtCalendarDayShort('2026-08-26T00:00:00.000Z')).toBe('Aug 26');
    expect(fmtCalendarDayShort('2026-08-26')).toBe('Aug 26');
    expect(fmtEta('2026-08-26T00:00:00.000Z', 'en-US')).toContain('Aug 26');
  });
  it('shows any other time as a local instant', () => {
    expect(fmtCalendarDayShort('2026-08-26T03:00:00.000Z')).toBe('Aug 25');
  });
});

describe('followUpDate', () => {
  it('counts from the Denver day in the evening', () => {
    // 18:00 MST Nov 22 is 01:00Z Nov 23.
    const now = new Date('2026-11-23T01:00:00Z');
    expect(followUpDate(7, now)).toBe('2026-11-29');
    expect(followUpDate(0, now)).toBe('2026-11-22');
  });
  it('steps calendar days across a month end', () => {
    expect(followUpDate(30, new Date('2026-11-22T18:00:00Z'))).toBe('2026-12-22');
  });
});

describe('localDayKey', () => {
  it('files an evening event under its local day', () => {
    expect(localDayKey('2026-11-24T01:00:00Z')).toBe('2026-11-23');
    expect(localDayKey('2026-11-23T15:00:00Z')).toBe('2026-11-23');
    expect(localDayKey('2026-11-24T15:00:00Z')).toBe('2026-11-24');
  });
});
