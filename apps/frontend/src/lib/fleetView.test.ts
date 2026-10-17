import { describe, it, expect } from 'vitest';
import { vncSocketUrl, type Challenge, type FleetAccount, type FleetDoc, type FleetWorker } from './coordinator';
import {
  accountAlerts, accountHaystack, attentionReason, browserLabel, canWatch, dayStrip, fleetPostsToday,
  externalVncUrl, fleetActivity, fleetStatus, flowCounts, hitsByCity, isUnstampedBuild, parkedWorkers, reloginIsAutomatic, reloginProgress,
  matchesTerms, offersRelogin, queryTerms, reviewedToday, searchedToday,
  splitHighlights, vaultAccountIdFor, whoIs,
  FLOW_STAGES, STAGE_FORMS, draftChanges, settingsDraft, settingsPatch,
  citiesDiffer, cityOwners, isCitySlug, marketplaceCityUrl, normalizeCitySlug,
  mergePins, pinsDiffer, searchesPerDay, keysymsFor,
} from './fleetView';

describe('keysymsFor', () => {
  it('maps Latin-1 to its code point and the rest to the Unicode keysym range', () => {
    expect(keysymsFor('a1Z')).toEqual([0x61, 0x31, 0x5a]);
    expect(keysymsFor('é')).toEqual([0xe9]);
    expect(keysymsFor('€')).toEqual([0x010020ac]);
  });
  it('drops control characters so a pasted line break cannot submit a form', () => {
    expect(keysymsFor('12\n34\t')).toEqual([0x31, 0x32, 0x33, 0x34]);
  });
});

const account = (over: Partial<FleetAccount>): FleetAccount => ({
  worker_id: 'w',
  source: 'fleet',
  region: { key: 'rs_southeast', name: 'Southeast', scope: 'region' },
  cities: [{ slug: 'dc', name: 'Washington, DC', radius_km: 100 }, { slug: 'tampa', name: 'Tampa, FL', radius_km: 100 }],
  session_file: null,
  proxy_env: null,
  pacing: { search_interval: null, max_search_interval: null, overridden: false },
  vnc_url: null,
  health: null,
  account: null,
  session: null,
  ...over,
});

describe('fleetView', () => {
  it('matches every term, case-insensitively, inside slugs too', () => {
    const terms = queryTerms('  Myers  FL ');
    expect(terms).toEqual(['myers', 'fl']);
    expect(matchesTerms('fort-myers-fl Fort Myers, FL', terms)).toBe(true);
    expect(matchesTerms('Miami, FL', terms)).toBe(false);
    expect(matchesTerms('anything', [])).toBe(true);
  });

  it('haystack covers id, region, cities and health', () => {
    const w = account({ health: { state: 'HEALTHY', liveness: 'live', account_id: 'acct-9' } as never });
    const hay = accountHaystack(w);
    for (const needle of ['w', 'rs_southeast', 'Southeast', 'Tampa, FL', 'tampa', 'HEALTHY', 'live', 'acct-9']) {
      expect(hay).toContain(needle);
    }
  });

  it('names the account from the vault first, then the session', () => {
    const w = account({
      account: { account_id: 'personal', fb_username: 'me@example.com', region: null, vnc_url: null, allow_password_login: false, proxy_configured: true, secrets: { totp_secret: true } },
      session: { account_id: 'personal', fb_user_id: '100000000000001', user_agent: null, session_expiry: null, backed_up_at: null },
    });
    expect(whoIs(w)).toEqual({ login: 'me@example.com', label: 'personal', userId: '100000000000001' });
    expect(accountHaystack(w)).toContain('100000000000001');
    expect(whoIs(account({}))).toEqual({ login: null, label: null, userId: null });
  });

  it('shortens a user agent to browser and OS', () => {
    expect(browserLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'))
      .toBe('Chrome 151 · macOS');
    expect(browserLabel('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120')).toBe('Chrome 120 · Linux');
    expect(browserLabel(null)).toBeNull();
    expect(browserLabel('curl/8.0')).toBe('curl/8.0');
  });

  it('splits highlighted runs without losing text', () => {
    const runs = splitHighlights('Tampa, FL', ['tampa']);
    expect(runs).toEqual([{ text: 'Tampa', hit: true }, { text: ', FL', hit: false }]);
    expect(splitHighlights('server ram memory', ['ram', 'memory']).filter(r => r.hit).map(r => r.text))
      .toEqual(['ram', 'memory']);
    expect(splitHighlights('x', [])).toEqual([{ text: 'x', hit: false }]);
    // Regex metacharacters in a term are literal.
    expect(splitHighlights('u.2 drives', ['u.2'])[0]).toEqual({ text: 'u.2', hit: true });
  });

  it('sums hits per city across buckets', () => {
    const m = hitsByCity([
      { day: 'd', priority: 'high', item_name: 'ram', search_city: 'tampa', sent: 1, hit: 0 },
      { day: 'd', priority: 'low', item_name: 'ram', search_city: 'tampa', sent: 1, hit: 1 },
      { day: 'd', priority: null, item_name: null, search_city: null, sent: 5, hit: 0 },
    ]);
    expect(m.get('tampa')).toEqual({ sent: 2, hit: 1 });
    expect(m.size).toBe(1);
  });

  it('credits alerts only to a worker that has reported', () => {
    const hits = hitsByCity([{ day: 'd', priority: null, item_name: null, search_city: 'tampa', sent: 3, hit: 0 }]);
    expect(accountAlerts(account({}), hits)).toBe(0);
    expect(accountAlerts(account({ health: { liveness: 'live' } as never }), hits)).toBe(3);
  });

  describe('needs a human', () => {
    const health = (over: Partial<FleetWorker>): FleetWorker => ({
      worker_id: 'w', state: 'HEALTHY', status: null, region: null, account_id: null,
      session_expiry: null, session_days_left: 300, last_heartbeat_at: '2026-10-04T09:00:00Z',
      last_search_at: null, last_listing_at: null, error_count: 0, vnc_url: null,
      liveness: 'live', needs_attention: false, ...over,
    });

    it('reads the most urgent reason first', () => {
      expect(attentionReason(account({ health: health({ liveness: 'dead', state: 'SESSION_EXPIRED' }) })).kind).toBe('dead');
      expect(attentionReason(account({ health: health({ state: 'SESSION_EXPIRED' }) })))
        .toEqual({ kind: 'state', state: 'SESSION_EXPIRED' });
      expect(attentionReason(account({ health: health({ session_days_left: 0 }) })).kind).toBe('expired');
      expect(attentionReason(account({ health: health({ session_days_left: 2 }) })))
        .toEqual({ kind: 'expiring', days: 2 });
      expect(attentionReason(account({ health: health({ session_days_left: 40 }) })).kind).toBe('other');
    });

    it('offers a re-login only where the session is the problem', () => {
      expect(offersRelogin(account({ health: health({ state: 'SESSION_EXPIRED' }) }))).toBe(true);
      expect(offersRelogin(account({ health: health({ session_days_left: -1 }) }))).toBe(true);
      expect(offersRelogin(account({ health: health({ state: 'CHECKPOINT' }) }))).toBe(false);
      expect(offersRelogin(account({ health: health({ state: 'SESSION_EXPIRED', liveness: 'dead' }) }))).toBe(false);
      expect(offersRelogin(account({}))).toBe(false);
    });

    it('puts a worker in one legend bucket, attention over liveness', () => {
      const parked = parkedWorkers([{ id: 7, worker_id: 'ne-1', kind: 'captcha' } as Challenge]);
      const status = (over: Partial<FleetWorker>, id = 'w') => fleetStatus(account({ worker_id: id, health: health(over) }), parked);
      expect(status({})).toBe('live');
      expect(status({ liveness: 'stale' })).toBe('stale');
      expect(status({}, 'ne-1')).toBe('attention');
      expect(status({ needs_attention: true })).toBe('attention');
      expect(status({ state: 'SESSION_EXPIRED' })).toBe('attention');
      expect(status({ liveness: 'dead', needs_attention: true })).toBe('offline');
      expect(status({ liveness: 'unknown' })).toBe('offline');
      expect(status({ state: 'DEAD' })).toBe('offline');
      expect(fleetStatus(account({}), parked)).toBe('offline');
      expect(parkedWorkers(null).size).toBe(0);
    });

    it('rebuilds recent activity from the timestamps, newest first', () => {
      const a = account({
        worker_id: 'a',
        health: health({ last_search_at: '2026-10-04T08:00:00Z', last_listing_at: '2026-10-04T08:30:00Z' }),
        session: { account_id: null, fb_user_id: null, user_agent: null, session_expiry: null, backed_up_at: '2026-10-03T12:00:00Z' },
      });
      const b = account({ worker_id: 'b', health: health({ liveness: 'dead', last_heartbeat_at: '2026-10-02T00:00:00Z' }) });
      const c = account({ worker_id: 'c', health: health({ last_heartbeat_at: '2026-10-04T09:00:00Z' }) });
      const fleet = { workers: [a, b, c] } as unknown as FleetDoc;
      const ch = { id: 7, worker_id: 'c', kind: 'captcha', created_at: '2026-10-04T09:10:00Z' } as Challenge;
      expect(fleetActivity(fleet, [ch]).map(e => `${e.workerId}:${e.kind}`))
        .toEqual(['c:checkpoint', 'a:listing', 'a:search', 'a:backup', 'b:silent']);
      expect(fleetActivity(null, null)).toEqual([]);
    });
  });

  it('counts every stage from today’s funnel row', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const today = {
      day: '2026-10-04', searches: 12, cards: 300, title_pass: 60, opened: 25, keyword_pass: 14,
      fresh: 9, reviewed: 8, alerted: 3, coordinated: 2, sent: 2,
    };
    expect(flowCounts([{ ...today, day: '2026-10-03', searches: 99 }, today], now)).toEqual({
      search: 12, cards: 300, title: 60, open: 25, keywords: 14, fresh: 9, ai: 8, coordinator: 2, alert: 2,
    });
    // Reported yesterday, quiet so far today: every stage reads 0.
    expect(flowCounts([{ ...today, day: '2026-10-03' }], now).search).toBe(0);
    expect(flowCounts([], now).alert).toBe(0);
    expect(flowCounts(null, now)).toEqual({});
  });

  it('falls back to the two old counters against an older console', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    expect(flowCounts([{ day: '2026-10-04', reviewed: 40, alerted: 3 }], now)).toEqual({ ai: 40, alert: 3 });
  });

  it('watches only what the facade can bridge to', () => {
    expect(canWatch(account({ vnc_live: true }))).toBe(true);
    expect(canWatch(account({ vnc_url: 'http://somewhere:6080' }))).toBe(false);
    expect(canWatch(null)).toBe(false);
  });

  it('builds the relay socket on the page’s own origin', () => {
    expect(vncSocketUrl('ne-1', { protocol: 'https:', host: 'inventory.recycleservers.com' }))
      .toBe('wss://inventory.recycleservers.com/api/coordinator/vnc/ne-1/ws');
    expect(vncSocketUrl('a b', { protocol: 'http:', host: 'localhost:5173' }))
      .toBe('ws://localhost:5173/api/coordinator/vnc/a%20b/ws');
  });

  it('counts today in UTC and the trailing seven days', () => {
    const now = Date.parse('2026-10-04T03:00:00Z');
    const days = [
      { day: '2026-09-27', reviewed: 1000, alerted: 0 },
      { day: '2026-09-28', reviewed: 10, alerted: 1 },
      { day: '2026-10-04', reviewed: 36, alerted: 2 },
    ];
    expect(reviewedToday(days, now)).toEqual({ today: 36, alertedToday: 2, last7: 46 });
    expect(reviewedToday([], now)).toEqual({ today: 0, alertedToday: 0, last7: 0 });
  });

  it('opens only absolute config VNC links, never a facade-relative path', () => {
    expect(externalVncUrl('/vnc/homelab-1')).toBeNull();
    expect(externalVncUrl('vnc/homelab-1')).toBeNull();
    expect(externalVncUrl('javascript:alert(1)')).toBeNull();
    expect(externalVncUrl(null)).toBeNull();
    expect(externalVncUrl('https://fbc-api.recycleservers.com/vnc/ne-1')).toBe('https://fbc-api.recycleservers.com/vnc/ne-1');
  });

  it('tells an unstamped image from a real build', () => {
    expect(isUnstampedBuild('unknown (unknown)')).toBe(true);
    expect(isUnstampedBuild('unknown')).toBe(true);
    expect(isUnstampedBuild('0.5.5 (9958051)')).toBe(false);
  });

  it('calls a re-login automatic only with a stored password the account may use', () => {
    const vault = (allow: boolean, secrets: Record<string, boolean>) =>
      account({ account: { account_id: 'a', fb_username: null, region: null, vnc_url: null,
        allow_password_login: allow, proxy_configured: false, secrets } });
    expect(reloginIsAutomatic(vault(true, { password: true, totp_secret: true }))).toBe(true);
    expect(reloginIsAutomatic(vault(false, { password: true }))).toBe(false);
    expect(reloginIsAutomatic(vault(true, { totp_secret: true }))).toBe(false);
    expect(reloginIsAutomatic(account({}))).toBe(false);
    expect(reloginIsAutomatic(null)).toBe(false);
  });

  it('follows a re-login from the queue to its outcome', () => {
    const asked = '2026-10-17T20:32:48+00:00';
    const t0 = Date.parse(asked);
    const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();
    const w = (h: Partial<FleetWorker>) => account({ health: h as FleetWorker });

    expect(reloginProgress(null)).toBeNull();
    expect(reloginProgress(account({}))).toBeNull();
    // A coordinator that predates re-login progress says nothing.
    expect(reloginProgress(w({ state: 'HEALTHY' }), t0)).toBeNull();

    const queued = reloginProgress(w({ relogin_requested_at: asked, relogin_last_requested_at: asked }), t0 + 5000);
    expect(queued).toEqual({ phase: 'queued', since: asked, active: true });

    // Picked up, no step reported yet: signing in from the request.
    expect(reloginProgress(w({ relogin_last_requested_at: asked }), t0 + 9000)?.phase).toBe('signing_in');

    const step = (login_step: string, seconds: number, now = seconds + 1) =>
      reloginProgress(w({ relogin_last_requested_at: asked, login_step, login_step_at: at(seconds) }), t0 + now * 1000);
    expect(step('typing', 11)?.phase).toBe('signing_in');
    expect(step('challenge', 40)).toEqual({ phase: 'needs_you', since: at(40), active: true });
    expect(step('waiting_for_human', 41)?.phase).toBe('needs_you');
    expect(step('logged_in', 90)).toEqual({ phase: 'done', since: at(90), active: false });
    expect(step('failed', 160)?.phase).toBe('failed');
    expect(step('some_future_step', 20)?.phase).toBe('signing_in');

    // A step from an earlier login is not this one's — but a worker clock a
    // few seconds behind the coordinator's still counts.
    expect(step('logged_in', -600, 5)?.phase).toBe('signing_in');
    expect(step('typing', -20, 5)?.phase).toBe('signing_in');
    expect(step('challenge', -20, 5)?.phase).toBe('needs_you');

    // Each phase is shown for a bounded time.
    expect(step('logged_in', 90, 90 + 61)).toBeNull();
    expect(step('challenge', 40, 40 + 16 * 60)).toBeNull();
    expect(reloginProgress(w({ relogin_requested_at: asked }), t0 + 31 * 60_000)).toBeNull();
  });
});


describe('vaultAccountIdFor', () => {
  const vault = { account_id: 'personal', fb_username: 'x@example.com', region: null, vnc_url: null,
    allow_password_login: false, proxy_configured: false, secrets: { password: false } };

  it('files credentials under the worker\'s own vault account when it has one', () => {
    expect(vaultAccountIdFor(account({ worker_id: 'homelab-1', account: vault }))).toBe('personal');
  });

  it('names a new account after the worker otherwise', () => {
    expect(vaultAccountIdFor(account({ worker_id: 'ne-1', account: null }))).toBe('ne-1');
  });
});

describe('how often a city is searched', () => {
  const city = { slug: 'denver', name: 'Denver', radius_km: 100 };

  it('is its count, capped by the start times, and unknown without both', () => {
    expect(searchesPerDay({ ...city, per_day: 3 }, 3)).toBe(3);
    expect(searchesPerDay({ ...city, per_day: 3 }, 2)).toBe(2);
    expect(searchesPerDay({ ...city, per_day: 1 }, 3)).toBe(1);
    expect(searchesPerDay(city, 3)).toBeNull();
    expect(searchesPerDay({ ...city, per_day: 3 }, null)).toBeNull();
  });

  it('replaces only this worker\'s pins, dropping removed cities', () => {
    const all = { denver: 3, boise: 1, seattle: 2 };
    expect(mergePins(all, ['denver', 'boise', 'reno'], { reno: 2 })).toEqual({ seattle: 2, reno: 2 });
    expect(mergePins(all, ['denver'], { denver: 3 })).toEqual(all);
  });

  it('notices any added, removed or changed pin', () => {
    expect(pinsDiffer({ a: 1 }, { a: 1 })).toBe(false);
    expect(pinsDiffer({ a: 1 }, { a: 2 })).toBe(true);
    expect(pinsDiffer({ a: 1 }, {})).toBe(true);
    expect(pinsDiffer({}, { b: 1 })).toBe(true);
  });
});

describe('a worker\'s cities', () => {
  it('accepts a slug or a numeric id, lowercased, and nothing else', () => {
    expect(isCitySlug(normalizeCitySlug(' LongIsland '))).toBe(true);
    expect(isCitySlug('108398645850982')).toBe(true);
    expect(isCitySlug('fort-myers-fl')).toBe(true);
    expect(isCitySlug('new york')).toBe(false);
    expect(isCitySlug('../etc')).toBe(false);
    expect(isCitySlug('')).toBe(false);
    expect(marketplaceCityUrl('portland_maine')).toBe('https://www.facebook.com/marketplace/portland_maine/');
  });

  it('names the other workers that already search a city', () => {
    const fleet = { workers: [
      account({ worker_id: 'nyc-1', cities: [{ slug: 'dc', name: 'Washington, DC', radius_km: 100 }] }),
      account({ worker_id: 'homelab-1' }),
      account({ worker_id: 'ne-1', cities: [{ slug: 'dc', name: 'Washington, DC', radius_km: 100 }] }),
      account({ worker_id: 'ghost', source: 'unconfigured' }),
    ] } as unknown as FleetDoc;
    const owners = cityOwners(fleet, 'nyc-1');
    expect(owners.get('dc')).toEqual(['homelab-1', 'ne-1']);
    expect(owners.get('tampa')).toEqual(['homelab-1']);
  });

  it('sees a reorder, a rename or a new radius as a change', () => {
    const a = [{ slug: 'dc', name: 'DC', radius: 100 }, { slug: 'tampa', name: 'Tampa', radius: 100 }];
    expect(citiesDiffer(a, a.map(c => ({ ...c })))).toBe(false);
    expect(citiesDiffer(a, [...a].reverse())).toBe(true);
    expect(citiesDiffer(a, [a[0], { ...a[1], radius: 60 }])).toBe(true);
    expect(citiesDiffer(a, [a[0]])).toBe(true);
  });
});

describe('stage settings forms', () => {
  const doc = {
    ai_model: 'openai/gpt-5.6-luna',
    search: {
      start_at: ['10:00'], date_listed: ['last 7 days', 'last 7 days'], delivery_method: 'local_pick_up',
      max_results: 120, search_interval: '45m', max_search_interval: '75m', title_prefilter: true,
      min_seller_rating: 4.5, exclude_unrated_sellers: false, rating: 4, min_unit_count: 5,
    },
    items: [
      { name: 'server_ram', enabled: true, search_phrases: ['server ram'], keywords: ['ram OR ddr4'], antikeywords: [] },
      { name: 'server_cpu', enabled: false, search_phrases: ['xeon'], keywords: [], antikeywords: [] },
    ],
  } as unknown as FleetDoc;
  const prompt = { prompt: 'judge it', rating_prompt: 'rate 1-5' };

  it('drafts what the chips show, enabled items only', () => {
    const d = settingsDraft(doc, prompt);
    expect(d.start_at).toBe('10:00');
    expect(d.date_listed).toBe('last 7 days');
    expect(d.rating).toBe('4');
    expect(Object.keys(d.items)).toEqual(['server_ram']);
    expect(d.items.server_ram.keywords).toBe('ram OR ddr4');
  });

  it('sends only the settings the stage edits', () => {
    const d = { ...settingsDraft(doc, prompt), start_at: '09:00, 21:00', max_results: '60' };
    d.items = { server_ram: { search_phrases: 'server ram\n\n  ddr4 lot  ', keywords: 'x', antikeywords: '' } };
    expect(settingsPatch('search', d, true)).toEqual({
      search: {
        start_at: ['09:00', '21:00'], date_listed: 'last 7 days', delivery_method: 'local_pick_up',
        max_results: 60, search_interval: '45m', max_search_interval: '75m',
      },
      items: { server_ram: { search_phrases: ['server ram', 'ddr4 lot'] } },
    });
    expect(settingsPatch('cards', d, true)).toEqual({ search: { max_results: 60 } });
    expect(settingsPatch('title', d, true)).toEqual({
      search: { title_prefilter: true }, items: { server_ram: { antikeywords: [] } },
    });
    expect(settingsPatch('open', d, true)).toEqual({});
  });

  it('sends the prompts only when they were loaded, and a half-typed number as typed', () => {
    const d = { ...settingsDraft(doc, prompt), rating: '3', min_unit_count: 'ten' };
    expect(settingsPatch('ai', d, true)).toEqual({
      search: { rating: 3, min_unit_count: 'ten', prompt: 'judge it', rating_prompt: 'rate 1-5' },
      ai_model: 'openai/gpt-5.6-luna',
    });
    expect(settingsPatch('ai', settingsDraft(doc, null), false).search).toEqual({ rating: 4, min_unit_count: 5 });
  });

  it('counts settings changed, list entries added or removed, and a reorder', () => {
    const base = settingsDraft(doc, prompt);
    expect(draftChanges(base, base)).toBe(0);
    const d = { ...base, rating: '3', items: { server_ram: { ...base.items.server_ram, antikeywords: 'hdd\nusb' } } };
    expect(draftChanges(base, d)).toBe(3);
    const swapped = { ...base, items: { server_ram: { ...base.items.server_ram, keywords: 'ram OR ddr4\n' } } };
    expect(draftChanges(base, swapped)).toBe(0);
    const reordered = { ...d, items: { server_ram: { ...d.items.server_ram, antikeywords: 'usb\nhdd' } } };
    expect(draftChanges(d, reordered)).toBe(1);
  });

  it('offers a form exactly on the stages that read a setting', () => {
    expect(FLOW_STAGES.filter(s => STAGE_FORMS[s])).toEqual(['search', 'cards', 'title', 'keywords', 'ai']);
  });
});

describe('dayStrip', () => {
  // 13:40 in Denver (MDT, UTC-6).
  const NOW = Date.parse('2026-10-17T19:40:00Z');
  const today = (over: Partial<NonNullable<FleetAccount['today']>>): FleetAccount['today'] => ({
    day: '2026-10-17', first_at: null, last_at: null, cycles: 0, searches: 0, posts: 0, alerts: 0, ...over,
  });
  const denver = (over: Partial<FleetAccount>) => account({
    timezone: 'America/Denver',
    plan: { phrases: 8, cities: 5, runs_per_day: 1, per_day: 40 },
    ...over,
  });

  it('draws a running sweep to now, with the tail to its estimated end', () => {
    // 07:25 → 13:40 local, 30 of 40 done: 375 min for 30, so 125 min to go.
    const w = denver({ today: today({ first_at: '2026-10-17T13:25:00Z', last_at: '2026-10-17T19:35:00Z', searches: 30 }) });
    const s = dayStrip(w, 'live', ['10:00'], NOW)!;
    expect(s).toMatchObject({ zone: 'MT', localNow: '13:40', start: '07:25', end: null, running: true, eta: '15:45', next: null });
    expect(s.segments.map(x => x.kind)).toEqual(['done', 'eta']);
    expect(s.segments[0].from).toBeCloseTo((7 * 60 + 25) / 1440);
    expect(s.segments[0].to).toBeCloseTo(s.nowAt);
  });

  it('ends a sweep at its last search once the budget is met or it goes quiet', () => {
    const done = denver({ today: today({ first_at: '2026-10-17T13:10:00Z', last_at: '2026-10-17T18:50:00Z', searches: 40 }) });
    expect(dayStrip(done, 'live', ['10:00'], NOW)).toMatchObject({ start: '07:10', end: '12:50', running: false, eta: null });
    const quiet = denver({ today: today({ first_at: '2026-10-17T13:10:00Z', last_at: '2026-10-17T18:50:00Z', searches: 12 }) });
    expect(dayStrip(quiet, 'live', ['10:00'], NOW)).toMatchObject({ end: '12:50', running: false });
  });

  it('gives only a start when the monitor reports cycles, not searches', () => {
    const w = denver({ today: today({ first_at: '2026-10-17T13:25:00Z', last_at: '2026-10-17T16:00:00Z', searches: null, cycles: 2 }) });
    expect(dayStrip(w, 'live', ['10:00'], NOW)).toMatchObject({ start: '07:25', end: null, running: false, searches: null });
  });

  it('names the next sweep when nothing ran today, and hatches a worker that is down', () => {
    const w = denver({ today: today({}) });
    // 10:00 UTC has passed: tomorrow, 04:00 Denver.
    expect(dayStrip(w, 'live', ['10:00'], NOW)!.next).toEqual({ time: '04:00', tomorrow: true });
    const early = Date.parse('2026-10-17T08:00:00Z');
    expect(dayStrip(w, 'live', ['10:00'], early)!.next).toEqual({ time: '04:00', tomorrow: false });
    expect(dayStrip(w, 'offline', ['10:00'], NOW)!.segments).toEqual([{ from: 0, to: 1, kind: 'rest' }]);
  });

  it('is null against a facade that serves no today', () => {
    expect(dayStrip(account({}), 'live', ['10:00'], NOW)).toBeNull();
  });

  it('sums the fleet’s posts only over workers that carry a count', () => {
    expect(fleetPostsToday([denver({ today: today({ posts: 23 }) }), denver({ today: today({ posts: 5 }) }), account({})])).toBe(28);
    expect(fleetPostsToday([account({})])).toBeNull();
  });

  it('knows the cities searched today, and falls back to liveness without a report', () => {
    const searched = searchedToday(denver({ today: today({ cities: ['denver'] }) }), 'live');
    expect([searched('denver'), searched('boulder')]).toEqual([true, false]);
    expect(searchedToday(denver({ today: today({ cities: [] }) }), 'live')('denver')).toBe(false);
    expect(searchedToday(denver({ today: today({}) }), 'live')('denver')).toBe(true);
    expect(searchedToday(denver({ today: today({ cities: null }) }), 'stale')('denver')).toBe(true);
    expect(searchedToday(account({}), 'offline')('denver')).toBe(false);
  });
});
