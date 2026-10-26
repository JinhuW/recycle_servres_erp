import { describe, expect, it } from 'vitest';
import { fleetDeviceFor, parseProxyUrl } from '../../../lib/fleet';
import { NOW, PROXIES, SLOTS } from './fixtures';
import { deviceSummary, fleetRowAction, proxyChoices, proxyDraftProblem, proxyPatch } from './proxyRules';

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

describe('proxyChoices', () => {
  it('counts the non-parked slots, marks the full ones and lists the emptiest first', () => {
    const c = proxyChoices(PROXIES, 2);
    expect(c.map((x) => [x.proxy.id, x.load, x.full])).toEqual([[3, 0, false], [2, 0, false], [1, 2, true]]);
    expect(proxyChoices(PROXIES, 3).find((x) => x.proxy.id === 1)!.full).toBe(false);
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
