import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FleetProxyHealth } from '@recycle-erp/shared';

// The Proxies tab's table renders its rows to markup without a DOM; with no
// language provider `t` returns its key. The fetchers are swapped out so the
// module graph never reaches lib/api.ts.
vi.mock('../../../lib/fleet', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fleet')>('../../../lib/fleet');
  const never = () => new Promise(() => undefined);
  return { ...actual, fleetApi: Object.fromEntries(Object.keys(actual.fleetApi).map(k => [k, vi.fn(never)])) };
});
vi.mock('../../../lib/facebookPool', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/facebookPool')>('../../../lib/facebookPool');
  const never = () => new Promise(() => undefined);
  return { ...actual, poolApi: Object.fromEntries(Object.keys(actual.poolApi).map(k => [k, vi.fn(never)])) };
});
vi.mock('../../../lib/errorToast', () => ({ handleFetchError: vi.fn(), showSuccessToast: vi.fn(), showWarnToast: vi.fn() }));

const { PROXIES } = await import('./fixtures');
const { ProxiesHealthTable, proxyMatches } = await import('./FleetProxiesTab');

const NOW = Date.parse('2026-10-27T15:00:00Z');
const at = '2026-10-27T14:58:00Z';
const empty = Array.from({ length: 48 }, () => null);
const UP: FleetProxyHealth = {
  exit: 'http://isp.example.net:10001', source: 'erp', proxy_id: 1, label: 'Decodo NY 1', host: 'isp.example.net', port: 10001,
  slots: [{ account_no: 12, pool_status: 'fleet', parked: false, leased: true }], workers: [], state: 'up',
  last: { at, ok: true, latency_ms: 640, exit_ip: '203.0.113.9', city: 'Ashburn', region: 'Virginia', country: 'US', org: 'AS64500', error: null },
  previous_ip: '198.51.100.4', uptime: 0.979, checks: 288, buckets: [...empty.slice(1), 'up'],
};
const DOWN: FleetProxyHealth = {
  exit: 'http://isp.example.com:10003', source: 'coordinator', proxy_id: null, label: null, host: 'isp.example.com', port: 10003,
  slots: [], workers: ['homelab-1', 'wc-1'], state: 'down',
  last: { at, ok: false, latency_ms: 8000, exit_ip: null, city: null, region: null, country: null, org: null, error: 'Timed out' },
  previous_ip: null, uptime: 0, checks: 4, buckets: [...empty.slice(2), 'down', 'down'],
};
const UNCHECKED: FleetProxyHealth = { ...UP, proxy_id: 2, label: 'Decodo NY 2', exit: 'NY 2', port: 10002, slots: [], state: 'unchecked', last: null, previous_ip: null, uptime: null, checks: 0, buckets: empty };
const filter = { state: 'all' as const, source: '' as const, q: '' };
const noop = () => undefined;

describe('Proxies tab', () => {
  it('lists every port, down first, with its health, exit, day and users', () => {
    const html = renderToString(<ProxiesHealthTable rows={[UP, DOWN, UNCHECKED]} marks={null} filter={filter} onFilter={noop} busy={null} onCheck={noop} now={NOW} />);
    expect(html.indexOf('isp.example.com:10003')).toBeLessThan(html.indexOf('isp.example.net:10001'));
    expect(html).toContain('fleetProxyDown');
    expect(html).toContain('Timed out');
    expect(html).toContain('640 ms');
    expect(html).toContain('203.0.113.9');
    expect(html).toContain('fleetProxyIpChanged');
    expect(html).toContain('fleetProxyUptime');
    expect(html).toContain('is-up');
    expect(html).toContain('homelab-1');
    expect(html).toContain('fleetAccountN');
    expect(html).toContain('fleetProxyNobody');
    expect(html).toContain('fleetProxyCheckOneHomelab');
  });

  it('filters by state and by the search box', () => {
    const down = renderToString(<ProxiesHealthTable rows={[UP, DOWN]} marks={null} filter={{ ...filter, state: 'down' }} onFilter={noop} busy={null} onCheck={noop} now={NOW} />);
    expect(down).toContain('isp.example.com:10003');
    expect(down).not.toContain('Decodo NY 1');
    expect(proxyMatches(UP, 'ashburn')).toBe(true);
    expect(proxyMatches(UP, '#12')).toBe(true);
    expect(proxyMatches(DOWN, 'wc-1 10003')).toBe(true);
    expect(proxyMatches(DOWN, 'ashburn')).toBe(false);
    expect(renderToString(<ProxiesHealthTable rows={[]} marks={null} filter={filter} onFilter={noop} busy={null} onCheck={noop} now={NOW} />))
      .toContain('fleetProxiesNone');
  });

  it("edits the ERP's own rows, with each one's load, and leaves the homelab's ports alone", () => {
    const editing = { proxies: PROXIES, limit: 2, onEdit: noop, onRemove: noop };
    const html = renderToString(<ProxiesHealthTable rows={[UP, DOWN]} marks={null} filter={filter} onFilter={noop} busy={null} onCheck={noop} editing={editing} now={NOW} />);
    expect(html.match(/fleetProxyEditTitle/g)).toHaveLength(2);   // aria-label and title, one row
    expect(html.match(/aria-label="fleetProxyRemove"/g)).toHaveLength(1);
    expect(html).toContain('fleetProxyUses');
    expect(html).toContain('fp-warn');                 // proxy 1 is at its limit
    const readOnly = renderToString(<ProxiesHealthTable rows={[UP]} marks={null} filter={filter} onFilter={noop} busy={null} editing={{ proxies: PROXIES, limit: 2 }} now={NOW} />);
    expect(readOnly).toContain('fleetProxyUses');
    expect(readOnly).not.toContain('fleetProxyRemove');
  });

  it('marks a crowded exit IP with a dot whose hover gives the reason', () => {
    const slots = (n: number, parked = false) => Array.from({ length: n }, (_, i) => ({ account_no: i + 1, pool_status: 'fleet', parked, leased: true }));
    const row = (over: Partial<FleetProxyHealth>) => renderToString(<ProxiesHealthTable rows={[{ ...UP, ...over }]} marks={null} filter={filter} onFilter={noop} busy={null} now={NOW} />);
    expect(row({ slots: slots(4) })).not.toContain('fleet-proxy-crowd');
    const warn = row({ slots: slots(5) });
    expect(warn).toContain('fleet-proxy-crowd is-warn');
    expect(warn).toContain('title="fleetProxyCrowdWarn"');
    expect(row({ slots: slots(10) })).toContain('is-warn');
    const over = row({ slots: slots(11) });
    expect(over).toContain('fleet-proxy-crowd is-over');
    expect(over).toContain('title="fleetProxyCrowdOver"');
    // Homelab workers count; parked accounts hold no browser on the port.
    expect(row({ slots: slots(3), workers: ['homelab-1', 'homelab-2'] })).toContain('is-warn');
    expect(row({ slots: slots(5, true) })).not.toContain('fleet-proxy-crowd');
    // Ports on one exit IP add up and all carry the dot, even with a filter on.
    const second: FleetProxyHealth = { ...UP, proxy_id: 9, label: 'Decodo NY 9', exit: 'http://isp.example.net:10009', port: 10009, slots: slots(3) };
    const shared = (f: typeof filter | { state: 'all'; source: ''; q: string }) => renderToString(<ProxiesHealthTable rows={[{ ...UP, slots: slots(3) }, second]} marks={null} filter={f} onFilter={noop} busy={null} now={NOW} />);
    expect(shared(filter).match(/fleet-proxy-crowd is-warn/g)).toHaveLength(2);
    expect(shared({ ...filter, q: '10009' }).match(/fleet-proxy-crowd is-warn/g)).toHaveLength(1);
    // A port with no known exit has no IP to count against.
    const noIp = row({ slots: slots(11), last: { ...UP.last!, ok: false, exit_ip: null } });
    expect(noIp).not.toContain('fleet-proxy-crowd');
  });
});
