// Pure helpers behind the Facebook fleet cards: liveness shorthand, the
// search-box matcher and its highlighter, and the two joins the coverage and
// accounts cards need (alert hits per city, active searchers per city).
// Kept out of the components so they can be unit-tested without React.

import type { AlertHitRow, FleetAccount } from './coordinator';

export type AccountLiveness = 'live' | 'stale' | 'dead' | 'unknown' | 'none';

// 'none' = the coordinator has no row for this worker at all (not deployed);
// 'unknown' = it has a row but the worker has never heartbeated.
export const liveness = (w: FleetAccount): AccountLiveness => w.health?.liveness ?? 'none';

// Live or stale: a worker whose city list is being searched right now. Stale
// counts because one missed cycle is normal on a jittered 45–75 min interval.
export const isActive = (w: FleetAccount): boolean => {
  const lv = liveness(w);
  return lv === 'live' || lv === 'stale';
};

export const needsAttention = (w: FleetAccount): boolean => Boolean(w.health?.needs_attention);

// Every whitespace-separated term must appear somewhere in the haystack,
// case-insensitively. A slug like "fort-myers-fl" therefore matches "myers".
export function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesTerms(haystack: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const h = haystack.toLowerCase();
  return terms.every(t => h.includes(t));
}

// Everything the search box may match an account on.
export function accountHaystack(w: FleetAccount): string {
  return [
    w.worker_id, w.health?.account_id, w.health?.state, liveness(w),
    w.region.key, w.region.name, w.source, w.proxy_env,
    w.account?.account_id, w.account?.fb_username, w.session?.fb_user_id,
    ...w.cities.flatMap(c => [c.name, c.slug]),
  ].filter(Boolean).join(' ');
}

// The Facebook identity behind a worker: login (email/name) from the vault
// account, numeric user id from the backed-up session, label as a fallback.
export function whoIs(w: FleetAccount): { login: string | null; label: string | null; userId: string | null } {
  return {
    login: w.account?.fb_username ?? null,
    label: w.account?.account_id ?? w.session?.account_id ?? null,
    userId: w.session?.fb_user_id ?? null,
  };
}

// "Chrome 151 · macOS" from a full user-agent string; the raw string,
// shortened, when nothing familiar matches.
export function browserLabel(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser = ua.match(/(Firefox|Edg|Chrome|Safari)\/(\d+)/);
  const os = /Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux|X11/.test(ua) ? 'Linux' : null;
  if (!browser) return ua.length > 40 ? `${ua.slice(0, 40)}…` : ua;
  const name = browser[1] === 'Edg' ? 'Edge' : browser[1];
  return `${name} ${browser[2]}${os ? ` · ${os}` : ''}`;
}

// Split text into runs so a component can wrap the matching ones in <mark>.
// Longest term first, so "ram" inside "ddr4 ram" and "ddr4" do not fight.
export function splitHighlights(
  text: string, terms: readonly string[],
): Array<{ text: string; hit: boolean }> {
  if (terms.length === 0 || !text) return [{ text, hit: false }];
  const escaped = [...terms].sort((a, b) => b.length - a.length)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'gi');
  const out: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), hit: false });
    out.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

export type CityHits = { sent: number; hit: number };

// Alert hits are bucketed by (day, priority, item, city); the cards only want
// per-city totals over the window.
export function hitsByCity(rows: readonly AlertHitRow[]): Map<string, CityHits> {
  const out = new Map<string, CityHits>();
  for (const row of rows) {
    if (!row.search_city) continue;
    const cur = out.get(row.search_city) ?? { sent: 0, hit: 0 };
    cur.sent += row.sent;
    cur.hit += row.hit;
    out.set(row.search_city, cur);
  }
  return out;
}

// Which of the given workers list a city — used with the active subset for
// "searched now" and with the fleet.toml subset for "assigned to".
export function searchersByCity(workers: readonly FleetAccount[]): Map<string, FleetAccount[]> {
  const out = new Map<string, FleetAccount[]>();
  for (const w of workers) {
    for (const c of w.cities) {
      const list = out.get(c.slug);
      if (list) list.push(w); else out.set(c.slug, [w]);
    }
  }
  return out;
}

// Alerts a worker can be credited with: hits are keyed by search city, so
// only a worker that has actually reported owns any — an undeployed worker
// sharing a region would otherwise be credited with the live monitor's.
export function accountAlerts(w: FleetAccount, hits: Map<string, CityHits>): number {
  if (!w.health) return 0;
  return w.cities.reduce((n, c) => n + (hits.get(c.slug)?.sent ?? 0), 0);
}
