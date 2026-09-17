import { describe, it, expect } from 'vitest';
import {
  REPORTING_TZ, RANGE_PRESETS, isIsoDate, todayIn, addDays, diffDays,
  startOfMonth, startOfYear, addMonths, resolvePreset, previousWindow, autoBucket,
} from '@recycle-erp/shared';

describe('reporting dates', () => {
  it('todayIn follows the business zone across the UTC day boundary', () => {
    // 04:30 UTC on the 18th is still the evening of the 17th in Denver.
    expect(todayIn(REPORTING_TZ, new Date('2026-09-18T04:30:00Z'))).toBe('2026-09-17');
    expect(todayIn('UTC', new Date('2026-09-18T04:30:00Z'))).toBe('2026-09-18');
    // 07:00 UTC in September (MDT, UTC-6) is 01:00 on the 18th.
    expect(todayIn(REPORTING_TZ, new Date('2026-09-18T07:00:00Z'))).toBe('2026-09-18');
  });

  it('isIsoDate accepts real calendar dates only', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-01-01')).toBe(false);
    expect(isIsoDate('2026-01-01T00:00')).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });

  it('addDays crosses month ends and the DST dates without drift', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');   // spring forward
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');   // fall back
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(diffDays('2026-01-01', '2026-12-31')).toBe(364);
    expect(diffDays('2026-09-17', '2026-09-17')).toBe(0);
  });

  it('month arithmetic clamps the day of month', () => {
    expect(startOfMonth('2026-09-17')).toBe('2026-09-01');
    expect(startOfYear('2026-09-17')).toBe('2026-01-01');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2026-09-17', -11)).toBe('2025-10-17');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('presets are calendar days ending today, inclusive', () => {
    const today = '2026-09-17';
    expect(resolvePreset('7d',  today, null)).toEqual({ from: '2026-09-11', to: today });
    expect(resolvePreset('30d', today, null)).toEqual({ from: '2026-08-19', to: today });
    expect(resolvePreset('90d', today, null)).toEqual({ from: '2026-06-20', to: today });
    expect(resolvePreset('mtd', today, null)).toEqual({ from: '2026-09-01', to: today });
    expect(resolvePreset('ytd', today, null)).toEqual({ from: '2026-01-01', to: today });
    expect(resolvePreset('12m', today, null)).toEqual({ from: '2025-09-18', to: today });
    expect(resolvePreset('all', today, '2026-02-26')).toEqual({ from: '2026-02-26', to: today });
    // No data at all: "all" is the trailing twelve months, never an empty window.
    expect(resolvePreset('all', today, null)).toEqual({ from: '2025-09-18', to: today });
    expect(RANGE_PRESETS).toEqual(['7d', '30d', '90d', 'mtd', 'ytd', '12m', 'all']);
  });

  it('previousWindow is the same length, ending the day before', () => {
    expect(previousWindow('2026-09-11', '2026-09-17')).toEqual({ from: '2026-09-04', to: '2026-09-10' });
    expect(previousWindow('2026-09-17', '2026-09-17')).toEqual({ from: '2026-09-16', to: '2026-09-16' });
    expect(previousWindow('2026-01-01', '2026-09-17')).toEqual({ from: '2025-04-16', to: '2025-12-31' });
  });

  it('autoBucket steps at 42 and 210 days', () => {
    expect(autoBucket('2026-09-17', '2026-09-17')).toBe('day');
    expect(autoBucket('2026-08-07', '2026-09-17')).toBe('day');    // 42 days
    expect(autoBucket('2026-08-06', '2026-09-17')).toBe('week');   // 43 days
    expect(autoBucket('2026-02-20', '2026-09-17')).toBe('week');   // 210 days
    expect(autoBucket('2026-02-19', '2026-09-17')).toBe('month');  // 211 days
  });
});
