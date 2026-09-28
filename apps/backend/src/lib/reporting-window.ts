// The dashboard's reporting window: two calendar dates in the business time
// zone, the equal-length window before them, and the chart's bucket size.
//
// `from`/`to` are the real interface. `range` presets survive for the phone
// dashboard and older clients — the shared resolver turns them into the same
// two dates, so "30 days" means one thing on both sides. An unknown preset
// still falls back to 30 days, as it always has; an explicit date that fails
// to parse is a 400, because a caller that sends dates meant them.

import type postgres from 'postgres';
import type { SqlLike } from '../db';
import {
  REPORTING_TZ, isIsoDate, isRangePreset, isBucket, todayIn, resolvePreset,
  previousWindow, autoBucket, addDays, diffDays,
  type IsoDate, type Bucket,
} from '@recycle-erp/shared';


export type ReportingWindow = {
  from: IsoDate;
  to: IsoDate;
  prevFrom: IsoDate;
  prevTo: IsoDate;
  bucket: Bucket;
  /** True when the bucket was derived from the span rather than requested. */
  bucketAuto: boolean;
  tz: string;
};

// generate_series over three years of days is still cheap; past that, a
// mistyped year should be refused rather than served.
const MAX_SPAN_DAYS = 1100;

export function parseReportingWindow(
  q: { from?: string; to?: string; range?: string; bucket?: string },
  now: Date = new Date(),
): ReportingWindow | null {
  const today = todayIn(REPORTING_TZ, now);
  let from: IsoDate;
  let to: IsoDate;
  if (q.from !== undefined || q.to !== undefined) {
    if (!isIsoDate(q.from) || !isIsoDate(q.to)) return null;
    if (q.from > q.to) return null;
    if (diffDays(q.from, q.to) + 1 > MAX_SPAN_DAYS) return null;
    from = q.from;
    to = q.to;
  } else {
    const key = isRangePreset(q.range) ? q.range : '30d';
    ({ from, to } = resolvePreset(key, today, null));
  }

  let bucket: Bucket;
  let bucketAuto: boolean;
  if (q.bucket !== undefined) {
    if (!isBucket(q.bucket)) return null;
    bucket = q.bucket;
    bucketAuto = false;
  } else {
    bucket = autoBucket(from, to);
    bucketAuto = true;
  }

  const prev = previousWindow(from, to);
  return { from, to, prevFrom: prev.from, prevTo: prev.to, bucket, bucketAuto, tz: REPORTING_TZ };
}

/** The instant a business-zone calendar day begins, as a timestamptz. */
function dayStart(sql: SqlLike, d: IsoDate, tz: string): postgres.Fragment {
  return sql`(${d}::date::timestamp AT TIME ZONE ${tz})`;
}

/** Half-open bounds for the window and the one before it. */
export function windowBounds(sql: SqlLike, w: ReportingWindow) {
  return {
    start:     dayStart(sql, w.from, w.tz),
    end:       dayStart(sql, addDays(w.to, 1), w.tz),
    prevStart: dayStart(sql, w.prevFrom, w.tz),
    prevEnd:   dayStart(sql, w.from, w.tz),
  };
}
