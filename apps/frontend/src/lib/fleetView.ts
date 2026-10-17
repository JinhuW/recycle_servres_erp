// Pure helpers behind the Facebook fleet tab: liveness shorthand and the
// legend's status, the search-box matcher and its highlighter, alert hits per
// city, the derived activity feed and the pipeline's stages.
// Kept out of the components so they can be unit-tested without React.

import type {
  AlertHitRow, Challenge, CityWrite, FleetAccount, FleetCity, FleetDoc, ReviewStatsDay, SearchSettingsWrite,
} from './coordinator';
import { ruleLines } from './keywordRules';

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

// Whether a city chip is green: searched in the worker's local day. A facade
// that predates the report serves null, and falls back to the worker's
// liveness so an ERP released ahead of the tracker does not grey every chip.
export function searchedToday(w: FleetAccount, status: FleetStatus): (slug: string) => boolean {
  const cities = w.today?.cities;
  if (cities == null) {
    const on = status === 'live' || status === 'stale';
    return () => on;
  }
  const done = new Set(cities);
  return slug => done.has(slug);
}

// Whether the ERP's own viewer can show this worker's browser: only a worker
// the facade bridges to (RS_VNC_TARGETS). A config-only vnc_url points at a
// host the ERP cannot reach on the manager's behalf.
export const canWatch = (w: FleetAccount | null | undefined): boolean => Boolean(w?.vnc_live);

// Why a flagged worker is flagged, most urgent first — the order the
// facade's own dashboard reads them in.
// A session this close to lapsing is worth a note; one further out is not.
export const SESSION_WARN_DAYS = 7;

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
  if (h.session_days_left !== null && h.session_days_left <= SESSION_WARN_DAYS) {
    return { kind: 'expiring', days: h.session_days_left };
  }
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
      name, Object.fromEntries(form.items.map(f => [f, ruleLines(fields[f])])),
    ]));
  }
  return body;
}

/**
 * How many edits separate a draft from the one it started as: each setting
 * changed, each list entry added or removed, and one for a list only
 * reordered, since the monitor runs search phrases in order. Zero means Save
 * has nothing to send — and a save that sends nothing still starts a sweep.
 */
export function draftChanges(base: SettingsDraft, draft: SettingsDraft): number {
  let n = 0;
  for (const key of Object.keys(base) as (keyof SettingsDraft)[]) {
    if (key !== 'items' && base[key] !== draft[key]) n++;
  }
  for (const [name, fields] of Object.entries(draft.items)) {
    for (const f of Object.keys(fields) as ItemField[]) {
      const was = ruleLines(base.items[name]?.[f] ?? '');
      const now = ruleLines(fields[f]);
      const left = [...was];
      let edits = 0;
      for (const entry of now) {
        const i = left.indexOf(entry);
        if (i >= 0) left.splice(i, 1);
        else edits++;
      }
      edits += left.length;
      n += edits || Number(was.join('\n') !== now.join('\n'));
    }
  }
  return n;
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

// ── Today ─────────────────────────────────────────────────────────────────────
// A worker's day, drawn 00:00–24:00 in its region's zone: the window it has
// searched, the now tick, and while a sweep runs, the tail to its estimated
// end. Positions are fractions of the local day.

const ZONE_LABEL: Record<string, string> = {
  'America/New_York': 'ET', 'America/Chicago': 'CT', 'America/Denver': 'MT', 'America/Los_Angeles': 'PT',
};
const DEFAULT_ZONE = 'America/New_York';

// A search reported this recently means the sweep is still under way. One
// search is a few minutes through the proxy; a quiet half hour is not.
export const SWEEP_IDLE_MS = 30 * 60_000;

function localClock(ms: number, zone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '0';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export type StripSegment = { from: number; to: number; kind: 'done' | 'eta' | 'rest' };
export type DayStrip = {
  zone: string;
  localNow: string;
  nowAt: number;
  segments: StripSegment[];
  start: string | null;
  // null while the sweep runs, and when only cycle starts are known (a
  // monitor that does not report single searches cannot say when it stopped).
  end: string | null;
  running: boolean;
  eta: string | null;
  // The next scheduled sweep, given only when nothing has run yet today.
  next: { time: string; tomorrow: boolean } | null;
  searches: number | null;
  budget: number | null;
};

// The next of the daily `start_at` times (UTC "HH:MM") after `now`.
function nextStart(startAt: readonly string[], now: number): number | null {
  let best: number | null = null;
  for (const hm of startAt) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
    if (!m) continue;
    const d = new Date(now);
    let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(m[1]), Number(m[2]));
    if (at <= now) at += 86_400_000;
    if (best === null || at < best) best = at;
  }
  return best;
}

export function dayStrip(
  w: FleetAccount,
  status: FleetStatus,
  startAt: readonly string[] | undefined,
  now: number = Date.now(),
): DayStrip | null {
  const today = w.today;
  if (!today) return null;
  const zone = w.timezone ?? DEFAULT_ZONE;
  const clock = localClock(now, zone);
  // Clamped to the day: a first search before local midnight starts at 0.
  const at = (ms: number) => {
    const c = localClock(ms, zone);
    return c.date < clock.date ? 0 : c.date > clock.date ? 1 : c.minutes / 1440;
  };
  const first = today.first_at ? Date.parse(today.first_at) : null;
  const last = today.last_at ? Date.parse(today.last_at) : null;
  const budget = w.plan?.per_day ?? null;
  const searches = today.searches;
  const working = status === 'live' || status === 'stale';
  const running = working && searches !== null && last !== null
    && now - last < SWEEP_IDLE_MS && (budget === null || searches < budget);

  const segments: StripSegment[] = [];
  let eta: string | null = null;
  if (first !== null && last !== null) {
    segments.push({ from: at(first), to: at(running ? now : last), kind: 'done' });
    if (running && budget !== null && searches !== null && searches > 0) {
      const e = localClock(now + ((now - first) / searches) * (budget - searches), zone);
      if (e.date === clock.date) {
        eta = hhmm(e.minutes);
        segments.push({ from: clock.minutes / 1440, to: e.minutes / 1440, kind: 'eta' });
      }
    }
  }
  if (!working) segments.push({ from: segments[0]?.to ?? 0, to: 1, kind: 'rest' });

  let next: DayStrip['next'] = null;
  if (first === null && startAt?.length) {
    const ms = nextStart(startAt, now);
    if (ms !== null) {
      const c = localClock(ms, zone);
      next = { time: hhmm(c.minutes), tomorrow: c.date !== clock.date };
    }
  }

  return {
    zone: ZONE_LABEL[zone] ?? zone,
    localNow: hhmm(clock.minutes),
    nowAt: clock.minutes / 1440,
    segments,
    start: first !== null ? hhmm(localClock(first, zone).minutes) : null,
    end: !running && searches !== null && last !== null ? hhmm(localClock(last, zone).minutes) : null,
    running,
    eta,
    next,
    searches,
    budget,
  };
}

// Today's new posts across the fleet, or null when no worker carries a count.
export function fleetPostsToday(workers: readonly FleetAccount[]): number | null {
  const counts = workers.map(w => w.today?.posts).filter((n): n is number => typeof n === 'number');
  return counts.length ? counts.reduce((a, b) => a + b, 0) : null;
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

// Where an operator's re-login has got to, for the strip on the Watch page.
// `relogin_requested_at` is set only while the request waits for the worker,
// so "queued" needs no clock comparison. After the hand-off, a login step
// counts only if it was stamped after the request; the worker stamps steps
// with its own clock, so a minute's slack absorbs drift from the
// coordinator's. Each phase is shown for a bounded time, so a strip never
// outlives the re-login it describes.
export type ReloginPhase = 'queued' | 'signing_in' | 'needs_you' | 'done' | 'failed';
export type ReloginProgress = { phase: ReloginPhase; since: string; active: boolean };

const RELOGIN_CLOCK_SLACK_MS = 60_000;
const RELOGIN_SHOW_MS: Record<ReloginPhase, number> = {
  queued: 30 * 60_000,
  signing_in: 10 * 60_000,
  needs_you: 15 * 60_000,
  done: 60_000,
  failed: 10 * 60_000,
};
const LOGIN_STEP_PHASE: Record<string, ReloginPhase> = {
  picked_up: 'signing_in',
  typing: 'signing_in',
  submitted: 'signing_in',
  challenge: 'needs_you',
  waiting_for_human: 'needs_you',
  logged_in: 'done',
  failed: 'failed',
};

export function reloginProgress(
  w: FleetAccount | null | undefined, now: number = Date.now(),
): ReloginProgress | null {
  const h = w?.health;
  if (!h) return null;
  const shown = (phase: ReloginPhase, since: string): ReloginProgress | null => {
    const at = Date.parse(since);
    if (!Number.isFinite(at) || now - at > RELOGIN_SHOW_MS[phase]) return null;
    return { phase, since, active: phase !== 'done' && phase !== 'failed' };
  };
  if (h.relogin_requested_at) return shown('queued', h.relogin_requested_at);
  const requested = h.relogin_last_requested_at;
  if (!requested) return null;
  const step = h.login_step;
  const stepAt = h.login_step_at;
  const stepMs = stepAt ? Date.parse(stepAt) : NaN;
  if (!step || !stepAt || !(stepMs >= Date.parse(requested) - RELOGIN_CLOCK_SLACK_MS)) {
    // Handed out, nothing reported yet — or a worker too old to report steps.
    return shown('signing_in', requested);
  }
  return shown(LOGIN_STEP_PHASE[step] ?? 'signing_in', stepAt);
}

// The vault account a worker's credentials are filed under: its own account
// when it has one, otherwise a new one named after the worker — the one id an
// operator already knows it by (`rsc vault set-account --account-id <worker>`).
export function vaultAccountIdFor(w: FleetAccount): string {
  return w.account?.account_id ?? w.worker_id;
}

// ── A worker's cities ─────────────────────────────────────────────────────────

// The monitor's rule for a Marketplace location: the segment after
// /marketplace/ in a search URL, a slug or a numeric id. Lowercased first,
// as the console does.
export const normalizeCitySlug = (raw: string): string => raw.trim().toLowerCase();
export const isCitySlug = (slug: string): boolean => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug);

// Where to check by eye that a slug is the place it claims: a wrong one
// silently searches the account's own area instead.
export const marketplaceCityUrl = (slug: string): string =>
  `https://www.facebook.com/marketplace/${encodeURIComponent(slug)}/`;

// Every city another worker searches, by slug. Those workers send their
// alerts straight to Telegram, so a city two workers share alerts twice.
export function cityOwners(fleet: FleetDoc, workerId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const w of fleet.workers) {
    if (w.worker_id === workerId || w.source === 'unconfigured') continue;
    for (const c of w.cities) out.set(c.slug, [...(out.get(c.slug) ?? []), w.worker_id]);
  }
  return out;
}

export function citiesDiffer(a: readonly CityWrite[], b: readonly CityWrite[]): boolean {
  return a.length !== b.length
    || a.some((c, i) => c.slug !== b[i].slug || c.name !== b[i].name || c.radius !== b[i].radius);
}

// ── How often a city is searched ──────────────────────────────────────────────

/**
 * How many times a day a city is actually searched: its ranked or pinned
 * count, capped by the worker's `start_at` times, since a city is searched at
 * most once per time. Null when the facade does not say.
 */
export function searchesPerDay(city: FleetCity, runsPerDay: number | null | undefined): number | null {
  if (city.per_day === undefined || !runsPerDay) return null;
  return Math.min(city.per_day, runsPerDay);
}

/**
 * The fleet-wide pin map after one worker's form: pins on `workerSlugs` (the
 * cities the worker had and has, so a dropped city loses its pin too) are
 * replaced by `chosen`; pins elsewhere are kept.
 */
export function mergePins(
  all: Readonly<Record<string, number>>,
  workerSlugs: readonly string[],
  chosen: Readonly<Record<string, number>>,
): Record<string, number> {
  const mine = new Set(workerSlugs);
  const out: Record<string, number> = {};
  for (const [slug, n] of Object.entries(all)) if (!mine.has(slug)) out[slug] = n;
  for (const [slug, n] of Object.entries(chosen)) out[slug] = n;
  return out;
}

export function pinsDiffer(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const ka = Object.keys(a);
  return ka.length !== Object.keys(b).length || ka.some(k => a[k] !== b[k]);
}

// Keysyms for typing text into a VNC session. Latin-1 keysyms equal their
// code point; everything else is the Unicode range X11 reserves. Control
// characters are dropped: a stray Return would submit Facebook's form.
export function keysymsFor(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) continue;
    out.push(cp <= 0xff ? cp : 0x01000000 + cp);
  }
  return out;
}
