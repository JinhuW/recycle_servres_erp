import {
  WECHAT_MAX_GROUPS,
  WECHAT_MAX_ROWS,
  WECHAT_POINTS_BATCH,
  WECHAT_PRICE_BUCKETS,
  isWechatRowKind,
  type WechatDayPush,
  type WechatGroupCoverage,
  type WechatLine,
  type WechatPoint,
  type WechatPrice,
  type WechatRerunFinish,
  type WechatSideStats,
  type WechatTotals,
} from '@recycle-erp/shared';

// Shape checks for memtrade's push. It is our own tool, but it runs on another
// machine and its payload lands in SQL, so every field is checked here rather
// than trusted. A failure names the first bad path; the push is all or nothing.

export class PushError extends Error {}

const TEXT_MAX = 4000;
const SHORT_MAX = 200;
const LIST_MAX = 64;

type Obj = Record<string, unknown>;

function obj(v: unknown, at: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new PushError(`${at}: expected an object`);
  return v as Obj;
}

function arr(v: unknown, at: string, max: number): unknown[] {
  if (!Array.isArray(v)) throw new PushError(`${at}: expected an array`);
  if (v.length > max) throw new PushError(`${at}: more than ${max} entries`);
  return v;
}

function str(v: unknown, at: string, max = SHORT_MAX): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new PushError(`${at}: expected a string of 1–${max} characters`);
  }
  return v;
}

// The model sometimes returns an item without the line it came from.
function text(v: unknown, at: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw new PushError(`${at}: expected a string of up to ${max} characters`);
  return v;
}

const strOrNull = (v: unknown, at: string, max = SHORT_MAX): string | null =>
  v === null || v === undefined ? null : str(v, at, max);

function count(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 2_000_000_000) {
    throw new PushError(`${at}: expected a whole number ≥ 0`);
  }
  return v;
}

const countOrNull = (v: unknown, at: string): number | null =>
  v === null || v === undefined ? null : count(v, at);

function money(v: unknown, at: string): number {
  // NUMERIC(14,2) on the points; prices on the rows are JSON but get the same ceiling.
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v >= 1e12) {
    throw new PushError(`${at}: expected a price ≥ 0`);
  }
  return v;
}

function bool(v: unknown, at: string): boolean {
  if (typeof v !== 'boolean') throw new PushError(`${at}: expected true or false`);
  return v;
}

// What toISOString() writes, or the same with an offset. Date.parse alone takes
// formats Postgres's timestamptz cast doesn't, which would surface as a 500.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function instant(v: unknown, at: string): string {
  const s = str(v, at, 40);
  if (!ISO_INSTANT.test(s) || Number.isNaN(Date.parse(s))) throw new PushError(`${at}: expected an ISO timestamp`);
  return s;
}

const strings = (v: unknown, at: string, max = LIST_MAX): string[] =>
  arr(v ?? [], at, max).map((x, i) => str(x, `${at}[${i}]`));

function oneOf<T extends string>(v: unknown, allowed: readonly T[], at: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new PushError(`${at}: expected one of ${allowed.join(', ')}`);
  }
  return v as T;
}

const formFactor = (v: unknown, at: string) =>
  v === null || v === undefined ? null : oneOf(v, ['server', 'pc'] as const, at);

export function isReportDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function price(v: unknown, at: string): WechatPrice {
  const p = obj(v, at);
  return {
    bucket: oneOf(p.bucket, WECHAT_PRICE_BUCKETS, `${at}.bucket`),
    n: count(p.n, `${at}.n`),
    min: money(p.min, `${at}.min`),
    median: money(p.median, `${at}.median`),
    max: money(p.max, `${at}.max`),
    approx: count(p.approx, `${at}.approx`),
    outliers: count(p.outliers, `${at}.outliers`),
  };
}

function side(v: unknown, at: string): WechatSideStats {
  const s = obj(v, at);
  return {
    posts: count(s.posts, `${at}.posts`),
    senders: count(s.senders, `${at}.senders`),
    groups: count(s.groups, `${at}.groups`),
    exposures: count(s.exposures, `${at}.exposures`),
    qty: count(s.qty, `${at}.qty`),
    prices: arr(s.prices, `${at}.prices`, WECHAT_PRICE_BUCKETS.length).map((p, i) => price(p, `${at}.prices[${i}]`)),
  };
}

function line(v: unknown, at: string): WechatLine {
  const r = obj(v, at);
  if (!isWechatRowKind(r.kind)) throw new PushError(`${at}.kind: expected quote, spec or code`);
  return {
    kind: r.kind,
    key: str(r.key, `${at}.key`),
    brand: strOrNull(r.brand, `${at}.brand`),
    capacityGb: countOrNull(r.capacityGb, `${at}.capacityGb`),
    speed: countOrNull(r.speed, `${at}.speed`),
    code: strOrNull(r.code, `${at}.code`),
    ddr: strOrNull(r.ddr, `${at}.ddr`),
    formFactor: formFactor(r.formFactor, `${at}.formFactor`),
    ranks: strings(r.ranks, `${at}.ranks`),
    partNumbers: strings(r.partNumbers, `${at}.partNumbers`),
    signal: strOrNull(r.signal, `${at}.signal`),
    buy: side(r.buy, `${at}.buy`),
    sell: side(r.sell, `${at}.sell`),
  };
}

function totals(v: unknown, at: string): WechatTotals {
  const t = obj(v, at);
  const keys = ['messages', 'groupsTotal', 'groupsActive', 'candidates', 'posts', 'buyPosts', 'sellPosts', 'buyers', 'sellers'] as const;
  return Object.fromEntries(keys.map(k => [k, count(t[k], `${at}.${k}`)])) as WechatTotals;
}

function group(v: unknown, at: string): WechatGroupCoverage {
  const g = obj(v, at);
  return {
    id: str(g.id, `${at}.id`),
    // A WeChat group can have no topic set; the page shows its id instead.
    name: text(g.name, `${at}.name`, SHORT_MAX),
    messages: count(g.messages, `${at}.messages`),
    candidates: count(g.candidates, `${at}.candidates`),
    firstSeen: g.firstSeen === null || g.firstSeen === undefined ? null : instant(g.firstSeen, `${at}.firstSeen`),
  };
}

export function parseDayPush(body: unknown): WechatDayPush {
  const b = obj(body, 'body');
  const windowStart = instant(b.windowStart, 'windowStart');
  const windowEnd = instant(b.windowEnd, 'windowEnd');
  if (Date.parse(windowEnd) <= Date.parse(windowStart)) throw new PushError('windowEnd: must be after windowStart');
  const rows = arr(b.rows, 'rows', WECHAT_MAX_ROWS).map((r, i) => line(r, `rows[${i}]`));
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.kind}:${r.key}`;
    if (seen.has(k)) throw new PushError(`rows: ${k} appears twice`);
    seen.add(k);
  }
  const groups = arr(b.groups, 'groups', WECHAT_MAX_GROUPS).map((g, i) => group(g, `groups[${i}]`));
  if (new Set(groups.map(g => g.id)).size !== groups.length) throw new PushError('groups: an id appears twice');
  return {
    windowStart,
    windowEnd,
    degraded: bool(b.degraded, 'degraded'),
    summary: strOrNull(b.summary, 'summary', TEXT_MAX * 4),
    warnings: arr(b.warnings ?? [], 'warnings', LIST_MAX).map((w, i) => str(w, `warnings[${i}]`, TEXT_MAX)),
    totals: totals(b.totals, 'totals'),
    groups,
    rows,
    pointCount: count(b.pointCount, 'pointCount'),
  };
}

function point(v: unknown, at: string): WechatPoint {
  const p = obj(v, at);
  return {
    postKey: str(p.postKey, `${at}.postKey`),
    itemIndex: count(p.itemIndex, `${at}.itemIndex`),
    senderId: str(p.senderId, `${at}.senderId`),
    // As can a sender's display name.
    senderName: text(p.senderName, `${at}.senderName`, SHORT_MAX),
    groupIds: strings(p.groupIds, `${at}.groupIds`, WECHAT_MAX_GROUPS),
    firstAt: instant(p.firstAt, `${at}.firstAt`),
    lastAt: instant(p.lastAt, `${at}.lastAt`),
    messages: count(p.messages, `${at}.messages`),
    source: oneOf(p.source, ['llm', 'rules'] as const, `${at}.source`),
    direction: oneOf(p.direction, ['buy', 'sell'] as const, `${at}.direction`),
    brands: strings(p.brands, `${at}.brands`),
    capacityGb: countOrNull(p.capacityGb, `${at}.capacityGb`),
    speed: countOrNull(p.speed, `${at}.speed`),
    ddr: strOrNull(p.ddr, `${at}.ddr`),
    rank: strOrNull(p.rank, `${at}.rank`),
    formFactor: formFactor(p.formFactor, `${at}.formFactor`),
    partCodes: strings(p.partCodes, `${at}.partCodes`),
    dateCode: strOrNull(p.dateCode, `${at}.dateCode`),
    condition: strOrNull(p.condition, `${at}.condition`),
    price: p.price === null || p.price === undefined ? null : money(p.price, `${at}.price`),
    priceApprox: bool(p.priceApprox, `${at}.priceApprox`),
    currency: p.currency === null || p.currency === undefined ? null : oneOf(p.currency, ['RMB', 'USD'] as const, `${at}.currency`),
    tax: strOrNull(p.tax, `${at}.tax`),
    qty: countOrNull(p.qty, `${at}.qty`),
    location: strOrNull(p.location, `${at}.location`),
    rawLine: text(p.rawLine, `${at}.rawLine`, TEXT_MAX),
    rowKeys: strings(p.rowKeys, `${at}.rowKeys`),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePointsPush(body: unknown): { points: WechatPoint[]; pushId: string | null } {
  const b = obj(body, 'body');
  if (b.pushId !== undefined && (typeof b.pushId !== 'string' || !UUID_RE.test(b.pushId))) {
    throw new PushError('pushId: expected the id the day\'s push returned');
  }
  return {
    points: arr(b.points, 'points', WECHAT_POINTS_BATCH).map((p, i) => point(p, `points[${i}]`)),
    pushId: b.pushId ?? null,
  };
}

// memtrade's error is a log line; it is shown on the page, so it is cut, not refused.
const RERUN_ERROR_MAX = 2000;

export function parseRerunFinish(body: unknown): Required<WechatRerunFinish> {
  const b = obj(body, 'body');
  const ok = bool(b.ok, 'ok');
  const degraded = b.degraded === undefined ? false : bool(b.degraded, 'degraded');
  if (b.error !== undefined && b.error !== null && typeof b.error !== 'string') throw new PushError('error: expected a string');
  const error = typeof b.error === 'string' && b.error.trim() ? b.error.trim().slice(0, RERUN_ERROR_MAX) : '';
  if (!ok && !error) throw new PushError('error: a failed rerun says why');
  return { ok, degraded, error };
}

export const isUuid = (s: string) => UUID_RE.test(s);
