// WeChat market: the daily memory-module report memtrade builds from the
// team's WeChat trading groups and pushes to /api/wechat-market/push/*, and
// the shapes Monitors ▸ WeChat reads back. memtrade lives outside this repo,
// so the push half of this file is an HTTP contract: change it on both sides.

export const WECHAT_ROW_KINDS = ['quote', 'spec', 'code'] as const;
export type WechatRowKind = typeof WECHAT_ROW_KINDS[number];

export const isWechatRowKind = (v: unknown): v is WechatRowKind =>
  typeof v === 'string' && (WECHAT_ROW_KINDS as readonly string[]).includes(v);

export type WechatSide = 'buy' | 'sell';

// A currency and tax basis. Prices in different buckets are never compared:
// 16000 含税 and 15000 未税 can be the same deal.
export const WECHAT_PRICE_BUCKETS = ['RMB含税', 'RMB未税', 'RMB', 'USD'] as const;
export type WechatPriceBucket = typeof WECHAT_PRICE_BUCKETS[number];

// One bucket's quotes on one side of a line: each trader's latest price,
// outliers (2.5x off the median) already dropped.
export type WechatPrice = {
  bucket: WechatPriceBucket;
  n: number;
  min: number;
  median: number;
  max: number;
  approx: number;
  outliers: number;
};

export type WechatSideStats = {
  posts: number;
  senders: number;
  groups: number;
  exposures: number;
  qty: number;
  // Most quotes first, so [0] is the headline price.
  prices: WechatPrice[];
};

export type WechatTotals = {
  messages: number;
  groupsTotal: number;
  groupsActive: number;
  candidates: number;
  posts: number;
  buyPosts: number;
  sellPosts: number;
  buyers: number;
  sellers: number;
};

export type WechatGroupCoverage = {
  id: string;
  name: string;
  messages: number;
  candidates: number;
  firstSeen: string | null;
};

export type WechatLine = {
  kind: WechatRowKind;
  key: string;
  brand: string | null;
  capacityGb: number | null;
  speed: number | null;
  code: string | null;
  ddr: string | null;
  formFactor: 'server' | 'pc' | null;
  ranks: string[];
  partNumbers: string[];
  // 紧缺 偏紧 均衡 偏松 过剩: memtrade's read of buy vs sell posts.
  signal: string | null;
  buy: WechatSideStats;
  sell: WechatSideStats;
};

// ── Push (memtrade → ERP) ─────────────────────────────────────────────────────

// PUT /api/wechat-market/push/days/:date replaces the day with this, and
// answers with the push's `pushId`.
export type WechatDayPush = {
  windowStart: string;
  windowEnd: string;
  degraded: boolean;
  summary: string | null;
  warnings: string[];
  totals: WechatTotals;
  groups: WechatGroupCoverage[];
  rows: WechatLine[];
  // How many points the batches that follow will carry.
  pointCount: number;
};

// POST /api/wechat-market/push/days/:date/points, in batches of
// `{ points: WechatPoint[], pushId? }`. A batch naming a pushId the day has
// since been replaced under is refused (409 day_replaced); one without is
// taken as the current push's.
export type WechatPoint = {
  postKey: string;
  itemIndex: number;
  senderId: string;
  senderName: string;
  groupIds: string[];
  firstAt: string;
  lastAt: string;
  messages: number;
  source: 'llm' | 'rules';
  direction: WechatSide;
  brands: string[];
  capacityGb: number | null;
  speed: number | null;
  ddr: string | null;
  rank: string | null;
  formFactor: 'server' | 'pc' | null;
  partCodes: string[];
  dateCode: string | null;
  condition: string | null;
  price: number | null;
  priceApprox: boolean;
  currency: 'RMB' | 'USD' | null;
  tax: string | null;
  qty: number | null;
  location: string | null;
  rawLine: string;
  // 'kind:key' of every line the item counted toward.
  rowKeys: string[];
};

export const WECHAT_MAX_ROWS = 5000;
export const WECHAT_MAX_GROUPS = 500;
export const WECHAT_POINTS_BATCH = 500;

// ── Read (Monitors ▸ WeChat) ──────────────────────────────────────────────────

export type WechatDaySummary = {
  date: string;
  windowStart: string;
  windowEnd: string;
  degraded: boolean;
  pushedAt: string;
  totals: WechatTotals;
  pointCount: number;
  storedPoints: number;
};

export type WechatDay = WechatDaySummary & {
  summary: string | null;
  warnings: string[];
  groups: WechatGroupCoverage[];
  // The report day before this one, which `prev` on each row compares with.
  prevDate: string | null;
  nextDate: string | null;
  // The day's latest re-run request, if a manager ever asked for one.
  rerun: WechatRerun | null;
};

// ── Re-run (the page asks, memtrade polls) ────────────────────────────────────

export type WechatRerunStatus = 'queued' | 'running' | 'done' | 'failed';

export type WechatRerun = {
  id: string;
  date: string;
  status: WechatRerunStatus;
  requestedBy: string | null;
  requestedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  // Done, but Claude was still unavailable and memtrade fell back to its rules.
  degraded: boolean;
  error: string | null;
};

/** What memtrade reports once it has rerun a claimed day. */
export type WechatRerunFinish = { ok: boolean; degraded?: boolean; error?: string };

/** A claimed request nobody finished in this long is taken as dead. */
export const WECHAT_RERUN_STALE_MS = 2 * 60 * 60 * 1000;

export type WechatRow = WechatLine & {
  // The line's headline prices on prevDate; null when it had no row that day.
  prev: { buy: WechatPrice | null; sell: WechatPrice | null } | null;
};

export type WechatEvidence = Omit<WechatPoint, 'rowKeys' | 'groupIds'> & { groups: string[] };

export type WechatHistoryDay = {
  date: string;
  buy: { senders: number; price: WechatPrice | null };
  sell: { senders: number; price: WechatPrice | null };
};

export const headlinePrice = (s: WechatSideStats): WechatPrice | null => s.prices[0] ?? null;

/** Day-over-day change of a headline price, as a fraction; null across buckets. */
export function priceChange(cur: WechatPrice | null, prev: WechatPrice | null): number | null {
  if (!cur || !prev || cur.bucket !== prev.bucket || prev.median === 0) return null;
  return (cur.median - prev.median) / prev.median;
}

/** What sellers ask over what buyers bid, in the first bucket both sides quote. */
export function priceSpread(row: Pick<WechatLine, 'buy' | 'sell'>): { value: number; bucket: WechatPriceBucket } | null {
  for (const b of row.buy.prices) {
    const s = row.sell.prices.find(p => p.bucket === b.bucket);
    if (s) return { value: s.median - b.median, bucket: b.bucket };
  }
  return null;
}
