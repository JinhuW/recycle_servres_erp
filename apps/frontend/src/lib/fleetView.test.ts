import { describe, it, expect } from 'vitest';
import type { FleetAccount } from './coordinator';
import {
  accountAlerts, accountHaystack, browserLabel, hitsByCity, matchesTerms, queryTerms,
  searchersByCity, splitHighlights, whoIs,
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
});
