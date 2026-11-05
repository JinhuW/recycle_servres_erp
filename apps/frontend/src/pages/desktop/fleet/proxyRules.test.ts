import { describe, expect, it } from 'vitest';
import type { FleetProxyHealth } from '@recycle-erp/shared';
import { fleetDeviceFor, parseProxyUrl } from '../../../lib/fleet';
import { NOW, PROXIES, SLOTS } from './fixtures';
import { deviceSummary, exitIpUsers, proxyExitFlags, fleetRowAction, proxyChangeVerdict, proxyChoices, proxyCrowding, proxyDraftProblem, proxyPatch, randomOpenProxy } from './proxyRules';

const row = (status: string, over: Partial<{ holder: string | null; password: string; totp: string }> = {}) =>
  ({ status, holder: null, password: 'pw', totp: 'KEY', ...over });

describe('fleetRowAction', () => {
  const free = SLOTS.find((s) => s.account_no === 40)!;      // no lease
  const held = SLOTS.find((s) => s.account_no === 31)!;      // a live lease
  const parked = SLOTS.find((s) => s.account_no === 44)!;
  it('offers Add to fleet for an available account with a login, blocked without one', () => {
    expect(fleetRowAction(row('available'), undefined, NOW)).toEqual({ kind: 'add' });
    expect(fleetRowAction(row('available', { totp: '' }), undefined, NOW)).toEqual({ kind: 'add-blocked' });
    expect(fleetRowAction(row('available', { password: '' }), undefined, NOW)).toEqual({ kind: 'add-blocked' });
  });
  it('leaves held, retired and coordinator accounts alone, but takes the ERP’s own leftover', () => {
    expect(fleetRowAction(row('taken', { holder: 'marcus' }), undefined, NOW)).toBeNull();
    expect(fleetRowAction(row('retired'), undefined, NOW)).toBeNull();
    expect(fleetRowAction(row('fleet', { holder: 'homelab-5' }), undefined, NOW)).toBeNull();
    expect(fleetRowAction(row('fleet', { holder: 'ERP fleet' }), undefined, NOW)).toEqual({ kind: 'add' });
  });
  it('offers Remove from fleet for a slot nobody holds, blocked while a worker does', () => {
    expect(fleetRowAction(row('fleet'), free, NOW)).toEqual({ kind: 'remove', slot: free });
    expect(fleetRowAction(row('fleet'), parked, NOW)).toEqual({ kind: 'remove', slot: parked });
    expect(fleetRowAction(row('fleet', { holder: 'worker-60-14-1' }), held, NOW)).toEqual({ kind: 'remove-blocked', slot: held });
  });
});

describe('proxyCrowding', () => {
  it('is quiet below 5, yellow from 5 through 10 and red above 10', () => {
    expect([0, 4, 5, 10, 11, 30].map(proxyCrowding)).toEqual([null, null, 'warn', 'warn', 'over', 'over']);
  });
});

describe('exitIpUsers', () => {
  const on = (ip: string | null, accounts: number, workers: string[] = [], parked = 0) => ({
    last: ip ? { exit_ip: ip } : { exit_ip: null }, workers,
    slots: [
      ...Array.from({ length: accounts }, (_, i) => ({ account_no: i, parked: false })),
      ...Array.from({ length: parked }, (_, i) => ({ account_no: 100 + i, parked: true })),
    ],
  }) as unknown as FleetProxyHealth;
  it('adds every port on an IP, workers in and parked accounts out, and skips an unknown exit', () => {
    const users = exitIpUsers([on('1.1.1.1', 2), on('1.1.1.1', 1, ['homelab-1'], 3), on('2.2.2.2', 1), on(null, 9)]);
    expect([...users]).toEqual([['1.1.1.1', 4], ['2.2.2.2', 1]]);
  });
});

describe('proxyChoices', () => {
  it('counts the non-parked slots, marks the full ones and lists the emptiest first', () => {
    const c = proxyChoices(PROXIES, 2);
    expect(c.map((x) => [x.proxy.id, x.load, x.full])).toEqual([[3, 0, false], [2, 0, false], [1, 2, true]]);
    expect(proxyChoices(PROXIES, 3).find((x) => x.proxy.id === 1)!.full).toBe(false);
  });
  it('draws the random proxy only from those with room', () => {
    const c = proxyChoices(PROXIES, 2);
    expect(randomOpenProxy(c, () => 0)!.id).toBe(3);
    expect(randomOpenProxy(c, () => 0.99)!.id).toBe(2);
    expect(randomOpenProxy(proxyChoices(PROXIES, 0))).toBeNull();
  });
  it('never draws a down proxy, and draws a healthy one while any is', () => {
    const down3 = proxyChoices(PROXIES, 2, new Map([[3, 'down']]));
    expect(down3.map((x) => [x.proxy.id, x.down])).toEqual([[2, false], [3, true], [1, false]]);
    expect(randomOpenProxy(down3, () => 0)!.id).toBe(2);
    expect(randomOpenProxy(down3, () => 0.99)!.id).toBe(2);
    const up2 = proxyChoices(PROXIES, 2, new Map([[2, 'up'], [3, 'degraded']]));
    expect(randomOpenProxy(up2, () => 0)!.id).toBe(2);
    expect(randomOpenProxy(up2, () => 0.99)!.id).toBe(2);
    // None up: any open one, unchecked or degraded alike.
    const none = proxyChoices(PROXIES, 2, new Map([[2, 'degraded']]));
    expect(randomOpenProxy(none, () => 0)!.id).toBe(3);
    expect(randomOpenProxy(proxyChoices(PROXIES, 2, new Map([[2, 'down'], [3, 'down']])))).toBeNull();
  });
});

describe('proxy form', () => {
  const draft = { label: 'NY 1', url: 'http://u:p@isp.example.net:10001', timezone: 'America/New_York', note: '' };
  it('wants a label, a URL with a port and an IANA zone', () => {
    expect(proxyDraftProblem(draft, false)).toBeNull();
    expect(proxyDraftProblem({ ...draft, label: ' ' }, false)).toBe('fleetProxyNeedLabel');
    expect(proxyDraftProblem({ ...draft, url: 'http://u:p@isp.example.net' }, false)).toBe('fleetProxyBadUrl');
    expect(proxyDraftProblem({ ...draft, url: '' }, false)).toBe('fleetProxyBadUrl');
    expect(proxyDraftProblem({ ...draft, timezone: 'New York' }, false)).toBe('fleetProxyBadTimezone');
    // Editing, an empty URL keeps the saved one.
    expect(proxyDraftProblem({ ...draft, url: '' }, true)).toBeNull();
  });
  it('sends only what changed, and the URL only when typed', () => {
    expect(proxyPatch(draft, null)).toEqual({ label: 'NY 1', timezone: 'America/New_York', url: draft.url });
    const saved = PROXIES[0];
    expect(proxyPatch({ label: saved.label, url: '', timezone: saved.timezone, note: saved.note }, saved)).toEqual({});
    expect(proxyPatch({ label: 'Renamed', url: '', timezone: 'America/Chicago', note: saved.note }, saved))
      .toEqual({ label: 'Renamed', timezone: 'America/Chicago' });
  });
  it('parses the shapes a vendor hands out', () => {
    expect(parseProxyUrl('http://user-abc:p%40ss@isp.example.net:10001')).toEqual({ scheme: 'http', host: 'isp.example.net', port: 10001, has_login: true });
    expect(parseProxyUrl('socks5://10.0.0.5:1080')).toMatchObject({ host: '10.0.0.5', port: 1080, has_login: false });
    expect(parseProxyUrl('ftp://a:b@h:1')).toHaveProperty('error');
    expect(parseProxyUrl('http://a@h:1')).toHaveProperty('error');
  });
});

describe('deviceSummary', () => {
  it('reads the generated device the dialog previews', () => {
    const d = fleetDeviceFor(31, 'America/Chicago');
    const s = deviceSummary(d);
    expect(s.timezone).toBe('America/Chicago');
    expect(s.screen).toBe(`${d.screen![0]}×${d.screen![1]}`);
    expect(s.scale).toBe(d.device_scale_factor);
  });
});

describe('proxyExitFlags', () => {
  const at = new Date(NOW - 60_000).toISOString();
  const check = { at, ok: true, latency_ms: 300, exit_ip: '203.0.113.9', city: 'Ashburn', region: 'Virginia', country: 'US', org: null, timezone: 'America/New_York', error: null };
  const use = (account_no: number, timezone: string | null) => ({ account_no, pool_status: 'fleet', parked: false, leased: true, timezone, held_exit_ip: null });
  const kinds = (p: Parameters<typeof proxyExitFlags>[0]) => proxyExitFlags(p, NOW).map((f) => f.kind);
  const clean = { last: check, slots: [use(1, 'America/New_York')], exit_change: null };
  it('has nothing to say about a fresh exit in the slots\' zone', () => {
    expect(kinds(clean)).toEqual([]);
  });
  it('flags only the slots whose device keeps another zone', () => {
    expect(proxyExitFlags({ ...clean, slots: [use(1, 'America/New_York'), use(2, 'America/Chicago'), use(3, null)] }, NOW)).toEqual([
      { kind: 'zone', zone: 'America/New_York', slots: [{ account_no: 2, timezone: 'America/Chicago' }] },
    ]);
  });
  it('says nothing about zones while the exit has none, as homelab ports and older rows do', () => {
    expect(kinds({ ...clean, last: { ...check, timezone: null }, slots: [use(1, 'America/Chicago')] })).toEqual([]);
  });
  it('flags a measurement older than three rounds, or none at all', () => {
    const old = new Date(NOW - 16 * 60_000).toISOString();
    expect(kinds({ ...clean, last: { ...check, at: new Date(NOW - 14 * 60_000).toISOString() } })).toEqual([]);
    expect(proxyExitFlags({ ...clean, last: { ...check, at: old } }, NOW)).toEqual([{ kind: 'stale', at: old }]);
    expect(proxyExitFlags({ ...clean, last: null }, NOW)).toEqual([{ kind: 'stale', at: null }]);
  });
  it('flags a fresh failure, and an old one as stale', () => {
    const failed = { ...check, ok: false, exit_ip: null, timezone: null, error: 'Timed out' };
    expect(kinds({ ...clean, last: failed })).toEqual(['failing']);
    expect(kinds({ ...clean, last: { ...failed, at: new Date(NOW - 16 * 60_000).toISOString() } })).toEqual(['stale']);
    expect(kinds({ ...clean, last: { ...check, exit_ip: null } })).toEqual(['failing']);
  });
  it('flags the pilot accounts whose first login waits', () => {
    expect(proxyExitFlags({ ...clean, slots: [use(1, 'America/New_York'), { ...use(2, 'America/New_York'), held_exit_ip: '198.51.100.4' }] }, NOW))
      .toEqual([{ kind: 'held', slots: [{ account_no: 2, exit_ip: '198.51.100.4' }] }]);
  });
  it('flags a recent exit change, alongside anything else that holds', () => {
    const change = { at, from: { ip: '198.51.100.4', city: null, region: null, country: null, timezone: null }, to: { ip: '203.0.113.9', city: null, region: null, country: null, timezone: null } };
    expect(proxyExitFlags({ ...clean, exit_change: change }, NOW)).toEqual([{ kind: 'changed', change }]);
    expect(kinds({ last: check, slots: [use(1, 'America/Chicago')], exit_change: change })).toEqual(['zone', 'changed']);
  });
});

describe('proxyChangeVerdict', () => {
  const last = (ok: boolean) => ({ at: '2026-11-04T00:00:00Z', ok, latency_ms: ok ? 300 : null, exit_ip: null, city: null, region: null, country: null, org: null, timezone: null, error: null });
  it('stops on a miss even when one blip only reads degraded', () => {
    expect(proxyChangeVerdict({ state: 'degraded', last: last(false) })).toBe('blocked');
    expect(proxyChangeVerdict({ state: 'down', last: last(false) })).toBe('blocked');
  });
  it('warns on a slow answer or a check that could not run', () => {
    expect(proxyChangeVerdict({ state: 'degraded', last: last(true) })).toBe('warn');
    expect(proxyChangeVerdict({ state: 'unchecked', last: null })).toBe('warn');
    expect(proxyChangeVerdict(null)).toBe('warn');
  });
  it('is clean only for an answer that reads up', () => {
    expect(proxyChangeVerdict({ state: 'up', last: last(true) })).toBe('ok');
  });
});
