import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Smoke tests for the watch page, both feeds: markup only, no DOM, so the
// socket and the polls never start (effects do not run in renderToString).
// With no language provider `t` returns its key.
vi.mock('../../../lib/fleet', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fleet')>('../../../lib/fleet');
  const never = () => new Promise(() => undefined);
  return { ...actual, fleetApi: Object.fromEntries(Object.keys(actual.fleetApi).map(k => [k, vi.fn(never)])) };
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
vi.mock('../../../lib/preferences', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/preferences')>('../../../lib/preferences');
  return { ...actual, usePreference: <T,>(_key: string, fallback: T) => [fallback, () => undefined] };
});
vi.mock('../../../lib/errorToast', () => ({ handleFetchError: vi.fn(), showSuccessToast: vi.fn(), showWarnToast: vi.fn() }));

const { NOW, POOL, WORKER_DETAIL } = await import('./fixtures');
const { FleetErpWatch } = await import('./FleetErpWatch');
const { FleetWatch } = await import('../FleetWatch');
const { WatchAccountPanel } = await import('./watchAccount');

// The page head, the viewer and the note every watch page has.
const LAYOUT = ['fbcWatchConnecting', 'fbcWatchControl', 'fbcRelogin', 'fbcWatchAcctHide', 'fbcWatchFullscreen', 'fl-watch-screen', 'fbcWatchNote'];

describe('watch page', () => {
  it('shows an ERP-fleet worker on the homelab watch layout, fed by the fleet', () => {
    const html = renderToString(<FleetErpWatch initial={WORKER_DETAIL} now={NOW} />);
    for (const k of LAYOUT) expect(html, k).toContain(k);
    expect(html).toContain('worker-60-14-1');                // the title
    expect(html).toContain('acct31@example.test');           // the back link names the login
    expect(html).toContain('worker-60-14');                  // host in the subtitle and the facts
    expect(html).toContain('fbcWatchHeartbeat');
    expect(html).toContain('fbcWatchAcctTitle');             // the sign-in panel
    expect(html).toContain('fbcWatchAcctLoading');           // the pool is read after mount
    for (const k of ['fbcWatchAcctState', 'fleetDetailHost', 'fbcColSession', 'fbcWatchAcctHeartbeat', 'fbcDetailProxy', 'fbcColBuild']) expect(html, k).toContain(k);
    expect(html).toContain('Decodo NY 1');
    expect(html).toContain('isp.example.net:10001 · America/New_York');
    expect(html).toContain('fleetBuildBehind');
    expect(html).not.toContain('fbcWatchAcctRegion');        // the fleet has no region
    expect(html).not.toContain('fl-relogin');                // no re-login under way
  });

  it('shows a re-login the fleet queued, and greys Re-login for a worker that is not running', () => {
    const queued = { ...WORKER_DETAIL, worker: { ...WORKER_DETAIL.worker, relogin: { id: 'r1', requested_at: new Date(NOW - 5_000).toISOString(), requested_by: 'alex', delivered_at: null } } };
    expect(renderToString(<FleetErpWatch initial={queued} now={NOW} />)).toContain('fleetReloginStripQueued');
    const stopped = { ...WORKER_DETAIL, holds_slot: false };
    const html = renderToString(<FleetErpWatch initial={stopped} now={NOW} />);
    expect(html).toMatch(/disabled=""[^>]*title="fleetWorkerNotRunning"/);
  });

  it('shows a homelab worker on the same layout, fed by the coordinator', () => {
    const html = renderToString(<FleetWatch workerId="homelab-5" />);
    for (const k of LAYOUT) expect(html, k).toContain(k);
    expect(html).toContain('homelab-5');
    expect(html).toContain('fbcWatchAcctLoading');
  });

  it('puts the pool login beside the browser, typing only under Take control', () => {
    const account = { ...POOL[4], password: 'pw-31', totp: 'JBSWY3DPEHPK3PXP' };
    const panel = (canType: boolean) => renderToString(
      <WatchAccountPanel pool={{ kind: 'ok', account }} asking profileId={null} missing={[]}
        facts={[{ key: 'host', label: 'fleetDetailHost', value: 'worker-60-14' }]} canType={canType} onType={() => true} />,
    );
    const html = panel(false);
    expect(html).toContain('fbcWatchAcctFromPool');          // Pool #31
    expect(html).toContain('fbcWatchAcctAsking');            // the 2FA card says Facebook asks
    expect(html).toContain('fbcWatchAcctType');
    expect(html).toContain('fbcWatchAcctTypeHint');          // disabled until Take control
    expect(html).toContain('acct31@example.test');
    expect(html).not.toContain('pw-31');                     // the password stays masked
    expect(html).toContain('profile.php?id=1000031000313131'); // the profile link from the pool uid
    expect(html).toContain('fbcWatchAcctWorker');
    expect(panel(true)).not.toContain('fbcWatchAcctTypeHint');
    const missing = renderToString(
      <WatchAccountPanel pool={{ kind: 'ok', account: null }} asking={false} profileId={null}
        missing={[{ key: 'login', label: 'fbcWatchAcctLogin', value: 'acct31@example.test' }]} facts={null} canType={false} onType={() => false} />,
    );
    expect(missing).toContain('fbcWatchAcctNotInPool');
    expect(missing).not.toContain('fbcWatchAcctWorker');
  });
});
