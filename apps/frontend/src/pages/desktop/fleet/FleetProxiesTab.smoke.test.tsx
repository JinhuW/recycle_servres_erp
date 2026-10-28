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
});
