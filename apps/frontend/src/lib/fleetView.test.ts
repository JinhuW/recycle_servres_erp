import { describe, it, expect } from 'vitest';
import { vncSocketUrl, type Challenge, type FleetAccount, type FleetDoc, type FleetWorker } from './coordinator';
import {
  accountAlerts, accountHaystack, attentionEntries, attentionReason, browserLabel, canWatch,
  externalVncUrl, hitsByCity, isUnstampedBuild, matchesTerms, offersRelogin, queryTerms, reviewedToday, searchersByCity,
  splitHighlights, whoIs,
} from './fleetView';

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

  it('indexes searchers per city', () => {
    const a = account({ worker_id: 'a' });
    const b = account({ worker_id: 'b', cities: [{ slug: 'dc', name: 'Washington, DC', radius_km: 100 }] });
    const m = searchersByCity([a, b]);
    expect(m.get('dc')?.map(w => w.worker_id)).toEqual(['a', 'b']);
    expect(m.get('tampa')?.map(w => w.worker_id)).toEqual(['a']);
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
    });

    it('offers a re-login only where the session is the problem', () => {
      expect(offersRelogin(account({ health: health({ state: 'SESSION_EXPIRED' }) }))).toBe(true);
      expect(offersRelogin(account({ health: health({ session_days_left: -1 }) }))).toBe(true);
      expect(offersRelogin(account({ health: health({ state: 'CHECKPOINT' }) }))).toBe(false);
      expect(offersRelogin(account({ health: health({ state: 'SESSION_EXPIRED', liveness: 'dead' }) }))).toBe(false);
      expect(offersRelogin(account({}))).toBe(false);
    });

    it('lists checkpoints first and does not repeat a parked worker', () => {
      const ne = account({ worker_id: 'ne-1', vnc_live: true, health: health({ needs_attention: true }) });
      const mw = account({ worker_id: 'mw-1', health: health({ needs_attention: true }) });
      const ok = account({ worker_id: 'sc-1', health: health({}) });
      const fleet = { workers: [ne, mw, ok] } as unknown as FleetDoc;
      const ch = { id: 7, worker_id: 'ne-1', kind: 'captcha' } as Challenge;
      const entries = attentionEntries(fleet, [ch]);
      expect(entries.map(e => e.kind === 'challenge' ? `c:${e.challenge.id}` : `w:${e.account.worker_id}`))
        .toEqual(['c:7', 'w:mw-1']);
      expect(entries[0]?.kind === 'challenge' && entries[0].account?.worker_id).toBe('ne-1');
      expect(attentionEntries(null, null)).toEqual([]);
    });
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
});

