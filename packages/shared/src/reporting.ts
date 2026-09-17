// Calendar arithmetic for the dashboard's reporting window.
//
// Shared because both sides have to agree on what "today", "last 30 days" and
// "year to date" mean: the client resolves a preset into two calendar dates,
// the server turns them into a half-open timestamp window. Dates are plain
// 'YYYY-MM-DD' strings and every helper does its arithmetic in UTC on the
// calendar values, so the only place a time zone enters is `todayIn`. The
// business runs on one clock — a manager in Denver and a purchaser in
// Shenzhen must see the same month, so the zone is a constant, not the
// viewer's.

export const REPORTING_TZ = 'America/Denver';

/** A calendar date, 'YYYY-MM-DD'. */
export type IsoDate = string;

export const RANGE_PRESETS = ['7d', '30d', '90d', 'mtd', 'ytd', '12m', 'all'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const BUCKETS = ['day', 'week', 'month'] as const;
export type Bucket = (typeof BUCKETS)[number];

export function isRangePreset(s: unknown): s is RangePreset {
  return typeof s === 'string' && (RANGE_PRESETS as readonly string[]).includes(s);
}

export function isBucket(s: unknown): s is Bucket {
  return typeof s === 'string' && (BUCKETS as readonly string[]).includes(s);
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toUtc(d: IsoDate): number {
  const m = ISO_RE.exec(d);
  if (!m) throw new Error(`not a calendar date: ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtc(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True for a well-formed date that survives a round trip — rejects Feb 30. */
export function isIsoDate(s: unknown): s is IsoDate {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  return fromUtc(toUtc(s)) === s;
}

/** The calendar date it is right now in `tz`. */
export function todayIn(tz: string, now: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD, which is the one locale that already spells
  // the ISO shape without reassembling parts.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromUtc(toUtc(d) + n * 86_400_000);
}

/** Days from `a` to `b`; positive when `b` is later. */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function startOfMonth(d: IsoDate): IsoDate {
  return d.slice(0, 8) + '01';
}

export function startOfYear(d: IsoDate): IsoDate {
  return d.slice(0, 5) + '01-01';
}

/** Same day of month `n` months away, clamped to the target month's length. */
export function addMonths(d: IsoDate, n: number): IsoDate {
  const m = ISO_RE.exec(d)!;
  const y = Number(m[1]), mo = Number(m[2]) - 1, day = Number(m[3]);
  const first = new Date(Date.UTC(y, mo + n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUtc(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay)));
}

/** Twelve months ending today, inclusive: the day after this date last year. */
function trailingYear(today: IsoDate): IsoDate {
  return addDays(addMonths(today, -12), 1);
}

/**
 * The window a preset names on a given day. `first` is the earliest date the
 * data has — "all" starts there, and falls back to the trailing year when
 * there is nothing yet so the window is never empty.
 */
export function resolvePreset(
  key: RangePreset, today: IsoDate, first: IsoDate | null,
): { from: IsoDate; to: IsoDate } {
  switch (key) {
    case '7d':  return { from: addDays(today, -6),  to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case '90d': return { from: addDays(today, -89), to: today };
    case 'mtd': return { from: startOfMonth(today), to: today };
    case 'ytd': return { from: startOfYear(today),  to: today };
    case '12m': return { from: trailingYear(today), to: today };
    case 'all': return { from: first ?? trailingYear(today), to: today };
  }
}

/** The equal-length window immediately before `[from, to]`. */
export function previousWindow(from: IsoDate, to: IsoDate): { from: IsoDate; to: IsoDate } {
  const len = diffDays(from, to) + 1;
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -(len - 1)), to: prevTo };
}

/** Bucket size that keeps a chart between roughly six and forty marks. */
export function autoBucket(from: IsoDate, to: IsoDate): Bucket {
  const n = diffDays(from, to) + 1;
  if (n <= 42) return 'day';
  if (n <= 210) return 'week';
  return 'month';
}
