import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// A mirror's fleet (dev's copy of prod's) renders without its writes: the
// banner says why, and the controls that would be refused are not there.
// The health read is primed before rendering, since renderToString runs no
// effects; the hook then starts from the cached answer.
vi.mock('../../../lib/fleet', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fleet')>('../../../lib/fleet');
  const never = () => new Promise(() => undefined);
  const api = Object.fromEntries(Object.keys(actual.fleetApi).map(k => [k, vi.fn(never)]));
  api.health = vi.fn(() => Promise.resolve({ ok: true, tables: {}, mirror: true }));
  return { ...actual, fleetApi: api };
});
vi.mock('../../../lib/coordinator', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/coordinator')>('../../../lib/coordinator');
  const never = () => new Promise(() => undefined);
  return { ...actual, coordinatorApi: Object.fromEntries(Object.keys(actual.coordinatorApi).map(k => [k, vi.fn(never)])) };
});
vi.mock('../../../lib/facebookPool', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/facebookPool')>('../../../lib/facebookPool');
  const never = () => new Promise(() => undefined);
  return { ...actual, poolApi: Object.fromEntries(Object.keys(actual.poolApi).map(k => [k, vi.fn(never)])) };
});
vi.mock('../../../lib/errorToast', () => ({ handleFetchError: vi.fn(), showSuccessToast: vi.fn(), showWarnToast: vi.fn() }));

const { HOSTS, NOW, RELEASE } = await import('./fixtures');
const { FleetMirrorBanner, loadFleetMirror, PROD_FLEET_URL } = await import('./shared');
const { FleetAccountsTab } = await import('./FleetAccountsTab');
const { HostStrip } = await import('./FleetHosts');

const noop = () => undefined;

describe('Fleet mirror', () => {
  it('shows the banner and leaves out Add host and the host writes', async () => {
    expect(await loadFleetMirror()).toBe(true);
    const banner = renderToString(<FleetMirrorBanner />);
    expect(banner).toContain('fleetMirrorNote');
    expect(banner).toContain(PROD_FLEET_URL);
    const tab = renderToString(<FleetAccountsTab />);
    expect(tab).not.toContain('fleetHostAdd');
    expect(tab).not.toContain('fleetReleaseAction');
    const strip = renderToString(<HostStrip hosts={HOSTS} release={RELEASE} onChanged={noop} now={NOW} />);
    expect(strip).toContain('role="switch"');           // the state still shows, disabled
    expect(strip).toMatch(/role="switch"[^>]*disabled/);
    expect(strip).not.toContain('fleetCapacityMore');
    expect(strip).not.toContain('fleetHostRemove');
  });
});
