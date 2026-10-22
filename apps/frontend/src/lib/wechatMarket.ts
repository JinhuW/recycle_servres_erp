// Client for Monitors ▸ WeChat (/api/wechat-market, manager-only): the daily
// memory-module report memtrade pushes from the team's WeChat groups, and the
// pure helpers the page sorts and formats it with.

import type {
  WechatDay,
  WechatDaySummary,
  WechatEvidence,
  WechatHistoryDay,
  WechatPrice,
  WechatPriceBucket,
  WechatRow,
  WechatRowKind,
  WechatSide,
} from '@recycle-erp/shared';
import { api } from './api';

const q = encodeURIComponent;

export const wechatApi = {
  days: () => api.get<{ days: WechatDaySummary[] }>('/api/wechat-market/days').then(r => r.days),
  day: (date: string, kind: WechatRowKind) =>
    api.get<{ day: WechatDay; rows: WechatRow[] }>(`/api/wechat-market/days/${q(date)}?kind=${kind}`),
  evidence: (date: string, kind: WechatRowKind, key: string, side?: WechatSide) =>
    api.get<{ points: WechatEvidence[]; limit: number }>(
      `/api/wechat-market/days/${q(date)}/points?kind=${kind}&key=${q(key)}${side ? `&side=${side}` : ''}`,
    ),
  history: (kind: WechatRowKind, key: string, until: string, days = 30) =>
    api.get<{ history: WechatHistoryDay[] }>(
      `/api/wechat-market/history?kind=${kind}&key=${q(key)}&until=${q(until)}&days=${days}`,
    ).then(r => r.history),
};

// The board leads with the brands the team trades most; memtrade writes an
// unbranded quote as 未注明, and those go last.
export const UNBRANDED = '未注明';
const BRAND_ORDER = ['三星', '海力士', '镁光', '长鑫'];

export function brandRank(brand: string | null): number {
  if (!brand || brand === UNBRANDED) return 99;
  const i = BRAND_ORDER.indexOf(brand);
  return i >= 0 ? i : 50;
}

export const hasPrice = (r: WechatRow) => r.buy.prices.length > 0 || r.sell.prices.length > 0;

/** Brand, then bigger and faster modules first, a code-less line ahead of its coded ones. */
export function boardOrder(a: WechatRow, b: WechatRow): number {
  return brandRank(a.brand) - brandRank(b.brand)
    || (a.brand ?? '').localeCompare(b.brand ?? '')
    || (b.capacityGb ?? 0) - (a.capacityGb ?? 0)
    || (b.speed ?? 0) - (a.speed ?? 0)
    || (a.code ?? '').localeCompare(b.code ?? '');
}

/** Traders on the line, both sides; the spec and code lists rank by it. */
export const traders = (r: WechatRow) => r.buy.senders + r.sell.senders;

export function matchesSearch(r: WechatRow, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return [r.key, r.brand ?? '', ...r.partNumbers, ...r.ranks].some(s => s.toLowerCase().includes(n));
}

export type BoardGroup = { brand: string | null; rows: WechatRow[] };

/** Quote lines grouped under brand headers, in board order. */
export function groupByBrand(rows: WechatRow[]): BoardGroup[] {
  const groups: BoardGroup[] = [];
  for (const r of [...rows].sort(boardOrder)) {
    const last = groups[groups.length - 1];
    if (last && last.brand === r.brand) last.rows.push(r);
    else groups.push({ brand: r.brand, rows: [r] });
  }
  return groups;
}

export function fmtPrice(value: number, bucket: WechatPriceBucket, locale: string): string {
  const n = new Intl.NumberFormat(locale, { maximumFractionDigits: value < 100 ? 2 : 0 }).format(value);
  return bucket === 'USD' ? `$${n}` : `¥${n}`;
}

// The tax basis a bucket stands for; plain RMB and USD quotes said nothing.
export const BUCKET_TAX_KEY: Record<WechatPriceBucket, string | null> = {
  RMB含税: 'wxTaxIncl',
  RMB未税: 'wxTaxExcl',
  RMB: null,
  USD: null,
};

// Every basis by name, where a price is shown away from its own cell.
export const BUCKET_LABEL_KEY: Record<WechatPriceBucket, string> = {
  RMB含税: 'wxTaxIncl',
  RMB未税: 'wxTaxExcl',
  RMB: 'wxTaxUnstated',
  USD: 'wxUsd',
};

/** "15,800–17,200", or null for a single quote. */
export function fmtRange(p: WechatPrice, locale: string): string | null {
  if (p.min === p.max) return null;
  return `${fmtPrice(p.min, p.bucket, locale)}–${fmtPrice(p.max, p.bucket, locale)}`;
}

// memtrade's supply/demand read of a line, as i18n keys.
export const SIGNAL_KEY: Record<string, string> = {
  紧缺: 'wxSignalShort',
  偏紧: 'wxSignalTight',
  均衡: 'wxSignalBalanced',
  偏松: 'wxSignalLoose',
  过剩: 'wxSignalGlut',
};
// Demand-heavy lines wear the bid's colour, supply-heavy ones the ask's.
export const SIGNAL_TONE: Record<string, 'info' | 'accent' | 'muted'> = {
  紧缺: 'info',
  偏紧: 'info',
  均衡: 'muted',
  偏松: 'accent',
  过剩: 'accent',
};

export type NoteBlock = { bold: boolean; text: string }[];

/** Claude's notes are markdown bullets; only `- ` items and **bold** are used. */
export function parseNotes(summary: string | null): NoteBlock[] {
  if (!summary) return [];
  return summary
    .split('\n')
    .map(l => l.replace(/^\s*(?:[-*•]|\d+\.)\s+/, '').trim())
    .filter(Boolean)
    .map(l => l.split(/\*\*(.+?)\*\*/).map((text, i) => ({ bold: i % 2 === 1, text })).filter(p => p.text));
}

/** Where a line sits between two prices, as a 0–100 share of the row's scale. */
export function ladder(row: Pick<WechatRow, 'buy' | 'sell'>): {
  bucket: WechatPriceBucket;
  bid: { from: number; to: number; at: number } | null;
  ask: { from: number; to: number; at: number } | null;
} | null {
  // Both sides share a scale only in a basis both quote, the same pairing
  // priceSpread makes. Otherwise the side with more quotes is drawn alone.
  let bid: WechatPrice | null = null;
  let ask: WechatPrice | null = null;
  for (const b of row.buy.prices) {
    const s = row.sell.prices.find(p => p.bucket === b.bucket);
    if (s) { bid = b; ask = s; break; }
  }
  if (!bid) {
    const b = row.buy.prices[0] ?? null;
    const s = row.sell.prices[0] ?? null;
    if (b && (!s || b.n >= s.n)) bid = b;
    else ask = s;
  }
  const ps = [bid, ask].filter((p): p is WechatPrice => p !== null);
  if (!ps.length) return null;
  const lo = Math.min(...ps.map(p => p.min));
  const hi = Math.max(...ps.map(p => p.max));
  const span = hi - lo;
  const at = (v: number) => (span === 0 ? 50 : ((v - lo) / span) * 100);
  const seg = (p: WechatPrice | null) => (p ? { from: at(p.min), to: at(p.max), at: at(p.median) } : null);
  return { bucket: ps[0]!.bucket, bid: seg(bid), ask: seg(ask) };
}
