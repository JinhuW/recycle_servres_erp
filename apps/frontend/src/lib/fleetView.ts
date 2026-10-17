// Pure helpers behind the Facebook fleet tab: liveness shorthand and the
// legend's status, the search-box matcher and its highlighter, alert hits per
// city, the derived activity feed and the pipeline's stages.
// Kept out of the components so they can be unit-tested without React.

import type { AlertHitRow, Challenge, FleetAccount, FleetDoc, ReviewStatsDay, SearchSettingsWrite } from './coordinator';

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

// Alerts a worker can be credited with: hits are keyed by search city, so
// only a worker that has actually reported owns any — an undeployed worker
// sharing a region would otherwise be credited with the live monitor's.
export function accountAlerts(w: FleetAccount, hits: Map<string, CityHits>): number {
  if (!w.health) return 0;
  return w.cities.reduce((n, c) => n + (hits.get(c.slug)?.sent ?? 0), 0);
}

// Whether the ERP's own viewer can show this worker's browser: only a worker
// the facade bridges to (RS_VNC_TARGETS). A config-only vnc_url points at a
// host the ERP cannot reach on the manager's behalf.
export const canWatch = (w: FleetAccount | null | undefined): boolean => Boolean(w?.vnc_live);

// Why a flagged worker is flagged, most urgent first — the order the
// facade's own dashboard reads them in.
export type AttentionReason =
  | { kind: 'dead'; since: string | null }
  | { kind: 'state'; state: string }
  | { kind: 'expired' }
  | { kind: 'expiring'; days: number }
  | { kind: 'other' };

export function attentionReason(w: FleetAccount): AttentionReason {
  const h = w.health;
  if (!h) return { kind: 'other' };
  if (h.liveness === 'dead') return { kind: 'dead', since: h.last_heartbeat_at };
  if (h.state && h.state !== 'HEALTHY') return { kind: 'state', state: h.state };
  if (h.session_days_left !== null && h.session_days_left <= 0) return { kind: 'expired' };
  if (h.session_days_left !== null) return { kind: 'expiring', days: h.session_days_left };
  return { kind: 'other' };
}

// A re-login fixes a worker whose Facebook session is the problem; it does
// nothing for one that stopped reporting or is parked on a checkpoint.
export function offersRelogin(w: FleetAccount): boolean {
  const h = w.health;
  if (!h || h.liveness === 'dead' || h.liveness === 'unknown') return false;
  return h.state === 'SESSION_EXPIRED' || (h.session_days_left !== null && h.session_days_left <= 0);
}

// The fleet tab's one status per worker, the legend's buckets. "Searching"
// versus "idle" is not offered: last_search_at stamps the start of a sweep
// that runs for hours, so it cannot say whether a worker is mid-sweep now.
// Attention outranks liveness — a live worker parked on a checkpoint is the
// one a manager has to act on.
export type FleetStatus = 'live' | 'stale' | 'attention' | 'offline';
export const FLEET_STATUSES: readonly FleetStatus[] = ['live', 'stale', 'attention', 'offline'];

export function fleetStatus(w: FleetAccount, parked: ReadonlySet<string>): FleetStatus {
  const lv = liveness(w);
  if (lv === 'dead' || lv === 'unknown' || lv === 'none' || w.health?.state === 'DEAD') return 'offline';
  if (parked.has(w.worker_id) || needsAttention(w) || (w.health?.state && w.health.state !== 'HEALTHY')) return 'attention';
  return lv === 'stale' ? 'stale' : 'live';
}

// Workers with an open checkpoint, by id.
export const parkedWorkers = (challenges: readonly Challenge[] | null): Set<string> =>
  new Set((challenges ?? []).map(ch => ch.worker_id));

// The Recent activity feed. The coordinator keeps no event log the ERP can
// read, so it is rebuilt from the timestamps it does serve: each worker's
// latest search, listing and session backup, the moment a dead worker last
// reported, and every open checkpoint.
export type FleetEventKind = 'search' | 'listing' | 'backup' | 'silent' | 'checkpoint';
export type FleetEvent = { at: string; workerId: string; kind: FleetEventKind; detail?: string };

export function fleetActivity(fleet: FleetDoc | null, challenges: readonly Challenge[] | null): FleetEvent[] {
  const out: FleetEvent[] = [];
  for (const w of fleet?.workers ?? []) {
    const h = w.health;
    if (h?.last_search_at) out.push({ at: h.last_search_at, workerId: w.worker_id, kind: 'search' });
    if (h?.last_listing_at) out.push({ at: h.last_listing_at, workerId: w.worker_id, kind: 'listing' });
    if (w.session?.backed_up_at) out.push({ at: w.session.backed_up_at, workerId: w.worker_id, kind: 'backup' });
    if (h?.liveness === 'dead' && h.last_heartbeat_at) out.push({ at: h.last_heartbeat_at, workerId: w.worker_id, kind: 'silent' });
  }
  for (const ch of challenges ?? []) {
    out.push({ at: ch.created_at, workerId: ch.worker_id, kind: 'checkpoint', detail: ch.kind });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// The pipeline a listing goes through, in the order the monitor and the
// coordinator run it: facebook.py search() → get_listings() → check_listing()
// on the card, the page visit, check_listing() with the description;
// monitor.py's already-notified skip and evaluate_by_ai(); the coordinator's
// dedupe by item id; the Telegram alert.
export type FlowStage = 'search' | 'cards' | 'title' | 'open' | 'keywords' | 'fresh' | 'ai' | 'coordinator' | 'alert';
export const FLOW_STAGES: readonly FlowStage[] = ['search', 'cards', 'title', 'open', 'keywords', 'fresh', 'ai', 'coordinator', 'alert'];

// ── Editing a stage's settings ──
// What each stage's Edit form changes: the same settings its chips show. The
// stages left out (open, fresh, coordinator, alert) read no setting; what
// they do is code in the monitor or the coordinator.
export type SearchField =
  | 'start_at' | 'date_listed' | 'delivery_method' | 'max_results' | 'search_interval'
  | 'max_search_interval' | 'title_prefilter' | 'min_seller_rating' | 'exclude_unrated_sellers'
  | 'rating' | 'min_unit_count';
export type ItemField = 'search_phrases' | 'keywords' | 'antikeywords';
type StageForm = { search: readonly SearchField[]; items: readonly ItemField[]; ai?: boolean };

export const STAGE_FORMS: Partial<Record<FlowStage, StageForm>> = {
  search: {
    search: ['start_at', 'date_listed', 'delivery_method', 'max_results', 'search_interval', 'max_search_interval'],
    items: ['search_phrases'],
  },
  cards: { search: ['max_results'], items: [] },
  title: { search: ['title_prefilter'], items: ['antikeywords'] },
  keywords: { search: ['min_seller_rating', 'exclude_unrated_sellers'], items: ['keywords', 'antikeywords'] },
  ai: { search: ['rating', 'min_unit_count'], items: [], ai: true },
};

// The form's state: text as typed, so a half-typed number is not coerced.
// Lists are one entry per line; sweep times are comma- or space-separated.
export type SettingsDraft = Record<Exclude<SearchField, 'title_prefilter' | 'exclude_unrated_sellers'>, string> & {
  title_prefilter: boolean;
  exclude_unrated_sellers: boolean;
  ai_model: string;
  prompt: string;
  rating_prompt: string;
  items: Record<string, Record<ItemField, string>>;
};

const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export function settingsDraft(
  fleet: FleetDoc,
  prompt: { prompt: string | null; rating_prompt: string | null } | null,
): SettingsDraft {
  const s = fleet.search;
  const window = Array.isArray(s.date_listed) ? s.date_listed[s.date_listed.length - 1] : s.date_listed;
  return {
    start_at: (s.start_at ?? []).join(', '),
    date_listed: text(window),
    delivery_method: text(s.delivery_method),
    max_results: text(s.max_results),
    search_interval: text(s.search_interval),
    max_search_interval: text(s.max_search_interval),
    title_prefilter: !!s.title_prefilter,
    min_seller_rating: text(s.min_seller_rating),
    exclude_unrated_sellers: !!s.exclude_unrated_sellers,
    rating: text(s.rating),
    min_unit_count: text(s.min_unit_count),
    ai_model: text(fleet.ai_model),
    prompt: text(prompt?.prompt),
    rating_prompt: text(prompt?.rating_prompt),
    items: Object.fromEntries(fleet.items.filter(i => i.enabled).map(i => [i.name, {
      search_phrases: i.search_phrases.join('\n'),
      keywords: i.keywords.join('\n'),
      antikeywords: i.antikeywords.join('\n'),
    }])),
  };
}

const lines = (v: string) => v.split('\n').map(l => l.trim()).filter(Boolean);
// A number the facade can check; anything else goes as typed, so its 400
// names the field instead of this side guessing.
const num = (v: string): number | string => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v.trim());

/**
 * The PUT body for one stage's form: only the settings that stage edits.
 * The prompts go only when they were loaded, so a save from a card that
 * could not read them never blanks them.
 */
export function settingsPatch(stage: FlowStage, draft: SettingsDraft, promptLoaded: boolean): SearchSettingsWrite {
  const form = STAGE_FORMS[stage];
  if (!form) return {};
  const search: Record<string, unknown> = {};
  for (const key of form.search) {
    const v = draft[key];
    if (typeof v === 'boolean') search[key] = v;
    else if (key === 'start_at') search[key] = v.split(/[\s,]+/).filter(Boolean);
    else if (key === 'date_listed' || key === 'delivery_method' || key === 'search_interval' || key === 'max_search_interval') search[key] = v.trim();
    else search[key] = num(v);
  }
  const body: SearchSettingsWrite = {};
  if (form.ai) {
    if (promptLoaded) {
      search.prompt = draft.prompt;
      if (draft.rating_prompt.trim()) search.rating_prompt = draft.rating_prompt;
    }
    body.ai_model = draft.ai_model.trim();
  }
  if (Object.keys(search).length) body.search = search as SearchSettingsWrite['search'];
  if (form.items.length) {
    body.items = Object.fromEntries(Object.entries(draft.items).map(([name, fields]) => [
      name, Object.fromEntries(form.items.map(f => [f, lines(fields[f])])),
    ]));
  }
  return body;
}

// The coordinator column behind each stage. Workers count the first seven,
// the coordinator the last two (ingest, then Telegram delivery).
const FLOW_COUNTER: Record<FlowStage, keyof ReviewStatsDay> = {
  search: 'searches', cards: 'cards', title: 'title_pass', open: 'opened', keywords: 'keyword_pass',
  fresh: 'fresh', ai: 'reviewed', coordinator: 'coordinated', alert: 'sent',
};

// Today's count per stage (UTC, as the coordinator buckets). A console older
// than the funnel counters sends rows without them: those stages stay
// uncounted, and the alert stage falls back to the workers' own `alerted`.
export function flowCounts(days: readonly ReviewStatsDay[] | null, now: number = Date.now()): Partial<Record<FlowStage, number>> {
  if (!days) return {};
  const funnel = days.length === 0 || days.some(d => d.searches !== undefined);
  const today = days.find(d => d.day === new Date(now).toISOString().slice(0, 10));
  if (!funnel) return { ai: today?.reviewed ?? 0, alert: today?.alerted ?? 0 };
  return Object.fromEntries(FLOW_STAGES.map(s => [s, today?.[FLOW_COUNTER[s]] ?? 0])) as Record<FlowStage, number>;
}

// Listings reviewed on the current UTC day (the coordinator buckets in UTC),
// with today's alerts and the trailing seven days' reviews.
export function reviewedToday(
  days: ReadonlyArray<{ day: string; reviewed: number; alerted: number }>,
  now: number = Date.now(),
): { today: number; alertedToday: number; last7: number } {
  const today = new Date(now).toISOString().slice(0, 10);
  const cutoff = new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);
  const row = days.find(d => d.day === today);
  return {
    today: row?.reviewed ?? 0,
    alertedToday: row?.alerted ?? 0,
    last7: days.filter(d => d.day >= cutoff).reduce((n, d) => n + d.reviewed, 0),
  };
}

// A VNC link written into config, usable from the ERP only if it is absolute.
// The facade hands out its own viewer as a path ("/vnc/homelab-1") meant for
// its own page; opened here it resolves against the ERP's origin and lands on
// a page that does not exist. Such a worker is watched through the ERP's
// viewer (canWatch) instead.
export function externalVncUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

// A build the image was not stamped with: the Dockerfile's "unknown" default,
// which says nothing about whether the worker is current.
export const isUnstampedBuild = (v: string): boolean => /^unknown\b/i.test(v.trim());

// Whether a re-login can finish on its own: the worker re-enters a password
// only when the vault holds one AND the account opts into password login.
// Otherwise the forced re-login clears the session and leaves Facebook's
// login form open for a person to complete through the viewer.
export function reloginIsAutomatic(w: FleetAccount | null | undefined): boolean {
  const acct = w?.account;
  return Boolean(acct?.allow_password_login && acct.secrets.password);
}

// The vault account a worker's credentials are filed under: its own account
// when it has one, otherwise a new one named after the worker — the one id an
// operator already knows it by (`rsc vault set-account --account-id <worker>`).
export function vaultAccountIdFor(w: FleetAccount): string {
  return w.account?.account_id ?? w.worker_id;
}

// What the credentials form is about to make true: Re-login finishes by
// itself only with a password stored AND password login allowed.
export function reloginWouldBeAutomatic(allowPasswordLogin: boolean, passwordStored: boolean): boolean {
  return allowPasswordLogin && passwordStored;
}
