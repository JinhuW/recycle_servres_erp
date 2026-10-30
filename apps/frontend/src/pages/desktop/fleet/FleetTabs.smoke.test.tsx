import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Smoke tests: each tab's table renders its fixtures to markup without a DOM.
// The fetchers are swapped out so the module graph never reaches lib/api.ts;
// the tables take their rows as props, which is also how the tabs hand them
// over after a poll. With no language provider `t` returns its key, so the
// assertions read keys and fixture values.
vi.mock('../../../lib/fleet', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/fleet')>('../../../lib/fleet');
  const never = () => new Promise(() => undefined);
  return {
    ...actual,
    fleetApi: Object.fromEntries(Object.keys(actual.fleetApi).map(k => [k, vi.fn(never)])),
  };
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
// Modal reads document on mount; a dialog's body renders the same without it.
vi.mock('../../../components/Modal', () => ({ Modal: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../../../lib/errorToast', () => ({ handleFetchError: vi.fn(), showSuccessToast: vi.fn(), showWarnToast: vi.fn() }));

const { CITIES, CITY_LOG, COORDINATOR, HITS, HOSTS, NOW, POOL, RELEASE, SLOTS, STATS, TASKS, WORKER_DETAIL, WORKER_STINTS, WORKERS } = await import('./fixtures');
const { WorkersTable } = await import('./FleetAccountsTab');
const { HostStrip, LowerCapacityDialog, ReleaseBanner } = await import('./FleetHosts');
const { Belt, CityLogAside, TaskTable } = await import('./FleetTasksTab');
const { CitiesTable } = await import('./FleetCitiesTab');
const { DayChart, HitsTable } = await import('./FleetAnalysisTab');
const { FlowCard } = await import('../FleetFlow');
const { ErpWorkerView } = await import('./FleetErpWorker');
const { HomelabWorkerView } = await import('../FleetWorker');
const { alertsByCity, daySeries, EMPTY_CITY_FILTER, EMPTY_TASK_FILTER, withCityNames } = await import('./fleetBoard');
const { DEFAULT_FLEET_ROW_FILTER, EMPTY_FLEET_ROW_FILTER } = await import('./fleetRows');

const noop = () => undefined;
const items = ['server_ram', 'enterprise_ssd'];
const fleetData = { slots: SLOTS, workers: WORKERS, hosts: HOSTS, release: RELEASE, coordinator: COORDINATOR, challenges: null, pool: POOL };

describe('Fleet tab', () => {
  it('shows one card per host with its switch, stepper and roll', () => {
    const html = renderToString(<HostStrip hosts={HOSTS} release={RELEASE} onChanged={noop} now={NOW} />);
    expect(html).toContain('homelab');
    expect(html).toContain('worker-60-14');
    expect(html).toContain('role="switch"');
    expect(html).toContain('fleetAuthoritativeOff');   // the observe-only host
    expect(html).toContain('fleetHostRolling');
    expect(html).toContain('1.340.0');
    expect(renderToString(<HostStrip hosts={[]} release={null} onChanged={noop} now={NOW} />)).toContain('fleetHostsNone');
  });
  it('names the containers a lower capacity removes, and the login it costs', () => {
    const html = renderToString(<LowerCapacityDialog host={HOSTS[0]} next={2} onClose={noop} onDone={noop} />);
    expect(html).toContain('fleetCapacityLowerTitle');
    expect(html).toContain('homelab-4');
    expect(html).toContain('homelab-3');
    expect(html).not.toContain('homelab-2');
    expect(html).toContain('fleetCapacityLowerRunning');
    expect(html).toContain('fleetCapacityLowerConfirm');
  });
  it('notes workers on an older build, with no bar, when no release rolls', () => {
    for (const release of [null, { ...RELEASE, state: 'done' as const }]) {
      const html = renderToString(<HostStrip hosts={HOSTS} release={release} onChanged={noop} now={NOW} />);
      expect(html).not.toContain('fleetHostRolling');
      expect(html).not.toContain('fleet-host-bar');
      expect(html).toContain('fleetHostBehind');        // homelab: two on 0.13.9
      expect(html).toContain('fleetHostWorkerVersion'); // worker-60-14 is current
    }
  });
  it('shows the latest roll from the hosts answer', () => {
    const html = renderToString(<ReleaseBanner release={RELEASE} now={NOW} />);
    expect(html).toContain('fleetReleaseState_rolling');
    expect(html).toContain('fleetRollReplacing');
    const failed = renderToString(<ReleaseBanner release={{ ...RELEASE, state: 'failed', current: null, failure: 'homelab-3 did not come back' }} now={NOW} />);
    expect(failed).toContain('homelab-3 did not come back');
  });
  it('lists every worker with its host, account, state and now', () => {
    const html = renderToString(<WorkersTable data={fleetData} filter={EMPTY_FLEET_ROW_FILTER} onFilter={noop} onChanged={noop} now={NOW} />);
    expect(html).toContain('fleetKindHealthy');
    expect(html).toContain('fleetNowReplacing');       // homelab-3 is being replaced
    expect(html).toContain('Philadelphia, PA');        // worker-60-14-1's current task
    expect(html).toContain('fleetNowWaiting');         // homelab-1 holds no task
    expect(html).toContain('homelab-5');               // the coordinator's worker is a row
    expect(html).toContain('fleetKindParked');         // homelab-9 never reported
    expect(html).toContain('fleetQuarantineUntilAt');  // homelab-4's account
    expect(html).toContain('fleetPark');
    expect(html).not.toContain('fleetUnpark');         // idle accounts are the pool's
    expect(html).not.toContain('fleetQuarantineRelease');
    expect(html).toContain('fleetEveryHost');
    expect(html).not.toContain(SLOTS[0].uid!);         // uids are masked
    expect(html).toContain('href="#/fleet/pool?account=31"'); // each account opens on the pool tab
    expect(html).toContain('fleetAccountOpenHint');
    expect(html).toContain('ff-ring-full');            // #12 has used its budget
    expect(html).toContain('fleetWorkersFoot');
  });
  it('has the Healthy, Free and Parked chips, and no retired worker', () => {
    const html = renderToString(<WorkersTable data={fleetData} filter={EMPTY_FLEET_ROW_FILTER} onFilter={noop} onChanged={noop} now={NOW} />);
    expect(html.match(/<i class="fp-dot"><\/i><span>(\w+)<\/span>/g)?.map(m => m.match(/<span>(\w+)/)![1]))
      .toEqual(['fleetKindAll', 'fleetKindHealthy', 'fleetKindFree', 'fleetKindParked']);
    // homelab-2 reports SESSION_EXPIRED on its own slot.
    expect(html).toContain('fleetReleaseParked');
    expect(html).not.toContain('homelab-20');
    expect(html).not.toContain('fleetRetiredOn');
  });
  it('opens on the Healthy chip', () => {
    const html = renderToString(<WorkersTable data={fleetData} filter={DEFAULT_FLEET_ROW_FILTER} onFilter={noop} onChanged={noop} now={NOW} />);
    expect(html).toMatch(/aria-pressed="true"[^>]*><i class="fp-dot"><\/i><span>fleetKindHealthy<\/span>/);
    expect(html).not.toContain('homelab-9');          // silent, so parked
    expect(html).toContain('fleetNowReplacing');      // homelab-3 still runs
  });
  it('honours the legend filter', () => {
    const html = renderToString(<WorkersTable data={fleetData} filter={{ ...EMPTY_FLEET_ROW_FILTER, kind: 'parked' }} onFilter={noop} onChanged={noop} now={NOW} />);
    expect(html).toContain('homelab-9');
    expect(html).toContain('homelab-2');
    expect(html).not.toContain('homelab-3');
  });
});

describe('Tasks tab', () => {
  it('draws the belt with a row per item, the marks and the due wall', () => {
    const html = renderToString(<Belt tasks={withCityNames(TASKS, CITIES)} items={items} workers={WORKERS} cityCount={4} now={NOW} />);
    expect(html.match(/fleet-belt-row/g)?.length).toBe(2);
    expect(html).toContain('fleet-bucket-done');
    expect(html).toContain('fleet-bucket-leased');
    expect(html).toContain('fleet-bucket-soon');
    expect(html).toContain('fleetBeltDueNow');
    expect(html).toContain('fleetBeltBusyIdle');
    expect(html).toContain('fleetBeltDue');
    expect(html).toContain('fleetBeltNow');
  });
  it('lists tasks with the state segment and their took, cards and alerts', () => {
    const html = renderToString(
      <TaskTable tasks={withCityNames(TASKS, CITIES)} items={items} filter={EMPTY_TASK_FILTER} onFilter={noop} range="24h" onRange={noop}
        selected={null} onSelect={noop} now={NOW} />,
    );
    expect(html).toContain('fleetState_leased');
    expect(html).toContain('fleetState_done');
    expect(html).toContain('fleetState_later');
    expect(html).toContain('fleetState_expired');
    expect(html).toContain('fleetSegRunning');
    expect(html).toContain('fleetKind_verify-slug');
    expect(html).toContain('6m 52s');                   // nyc's search took 412 s
    expect(html).toContain('fleet-alerted');            // and alerted once
    expect(html).toContain('fleetRange_7d');
    // Every state button carries its count; All counts every row.
    expect(html).toContain(`fleetSegAll<span class="fleet-seg-n">${TASKS.length}</span>`);
    expect(html.match(/fleet-seg-n/g)).toHaveLength(6);
  });
  it('honours a filter and marks the selected city', () => {
    const html = renderToString(
      <TaskTable tasks={withCityNames(TASKS, CITIES)} items={items} filter={{ ...EMPTY_TASK_FILTER, state: 'cancelled' }} onFilter={noop}
        range="24h" onRange={noop} selected="tulsa" onSelect={noop} now={NOW} />,
    );
    expect(html).toContain('Tulsa, OK');
    expect(html).not.toContain('Houston, TX');
    expect(html).toContain('fleet-row-sel');
  });
  it('asks for a row before it shows a city log', () => {
    expect(renderToString(<CityLogAside city={null} items={items} onSearchNow={noop} now={NOW} />)).toContain('fleetCityLogPick');
    const html = renderToString(<CityLogAside city={CITIES[0]} items={items} onSearchNow={noop} now={NOW} />);
    expect(html).toContain('Houston, TX');
    expect(html).toContain('fleetLogPerDay');          // twice a day
    expect(CITY_LOG.length).toBeGreaterThan(0);
  });
});

describe('Cities tab', () => {
  it('lists every city with its legend bucket, the per-item cells and the verify row', () => {
    const html = renderToString(
      <CitiesTable cities={CITIES} items={items} done={withCityNames(TASKS, CITIES)} filter={EMPTY_CITY_FILTER} onFilter={noop} onChanged={noop} now={NOW} />,
    );
    expect(html).toContain('Houston, TX');
    expect(html).toContain('fleetCityEnabled');
    expect(html).not.toContain('fleetColPin');
    expect(html).toContain('fleetCityVerifying');
    expect(html).toContain('fleetVerifyPending');      // boise's inline row
    expect(html).toContain('fleetVerifySkip');
    expect(html).toContain('fleetCityRestore');        // the removed row
    expect(html).toContain('fleetSearchNow');
    expect(html).toContain('homelab-3');               // Houston's lease, and its home worker
    expect(html).toContain('fleetDueWaiting');         // denver is overdue
    expect(html).toContain('fleetNextAt');             // nyc's next search
    expect(html).toContain('fleetResultCards');        // nyc's last search carries its cards
    expect(html).toContain('facebook.com/marketplace/houston/');
    expect(html).toContain('fleetEveryRegion');
  });
  it('names a slug mismatch', () => {
    const santafe = { ...CITIES[4], slug: 'santafe', name: 'Santa Fe, NM', verified_as: 'Santa Fe Springs, California' };
    const html = renderToString(
      <CitiesTable cities={[santafe]} items={items} done={[]} filter={EMPTY_CITY_FILTER} onFilter={noop} onChanged={noop} now={NOW} />,
    );
    expect(html).toContain('fleetVerifyMismatch');
    expect(html).toContain('fleetCityEnableAnyway');
  });
  it('has an empty row without cities', () => {
    expect(renderToString(<CitiesTable cities={[]} items={items} done={[]} filter={EMPTY_CITY_FILTER} onFilter={noop} onChanged={noop} now={NOW} />))
      .toContain('fleetCitiesNone');
  });
});

describe('Analysis tab', () => {
  it('shows the pipeline over the range with pass rates and the headline', () => {
    const html = renderToString(<FlowCard fleet={null} stats={STATS} prompt="unavailable" onSaved={noop} range={7} now={NOW} />);
    expect(html).toContain('fleetFunnelSub_7');
    expect(html).toContain('fleet-gap');
    expect(html).toContain('×5');                      // cards per search
    expect(html).toContain('fleetFunnelHeadline');
    expect(html).toContain('fleetFlowUnitRange_ai');
  });
  it('shows what passed the model and what was held back', () => {
    const html = renderToString(<FlowCard fleet={null} stats={STATS} prompt="unavailable" onSaved={noop} range={1} now={NOW} />);
    expect(html).toContain('fleet-gap-drop');          // the title gate drops over half
    expect(html).toContain('fbcFlow_passed');
    expect(html).toContain('fleetFlowWithheld');
    expect(html).toContain('fleetFunnelWithheld');
    expect(html).not.toContain('fbcFlowNotCounted');
  });
  it('draws a per-day chart with three gridlines, a grey today and the sums', () => {
    const html = renderToString(<DayChart title="t" sub="s" series={daySeries(STATS, 'alerted', 14, NOW)} unit="alerted" locale="en-US" />);
    expect(html.match(/fleet-chart-grid/g)?.length).toBe(3);
    expect(html.match(/<path /g)?.length).toBe(14);
    expect(html).toContain('fleet-chart-bar-dim');
    expect(html).toContain('fleetChartToday');
    expect(html).toContain('fleetChartTotal');
    expect(html).toContain('<title>');
  });
  it('lists the cities the alerts came from', () => {
    const html = renderToString(<HitsTable rows={alertsByCity(HITS, TASKS, CITIES)} />);
    expect(html).toContain('Houston, TX');
    expect(html).toContain('fleetColAlertRate');
    expect(renderToString(<HitsTable rows={[]} />)).toContain('fleetHitsNone');
  });
});

describe('Worker page', () => {
  // Both kinds of worker render on the same layout: the head, the credential
  // card with the same stat row and rows, checkpoints, accounts used, the city
  // log and the history column.
  const LAYOUT = ['ff-worker-layout', 'fp-credential ff-worker-card', 'ff-ledger', 'ff-history', 'fbcAccountsUsed', 'fbcCityLog', 'fbcOpenCheckpoints'];
  const ROWS = ['fbcDetailFbLogin', 'fbcDetailFbUser', 'fbcDetailSecrets', 'fbcColSession', 'fbcDetailUa', 'fbcDetailBackup', 'fbcDetailProxy', 'fbcFoldPacing', 'fbcDetailSessionFile', 'fbcColBuild'];
  const STATS_ROW = ['fbcColAlerts', 'fbcColLastSearch', 'fbcDetailLastListing', 'fbcDetailErrors'];

  it('shows an ERP-fleet worker on the homelab layout, from its one read', () => {
    const html = renderToString(<ErpWorkerView detail={WORKER_DETAIL} stints={WORKER_STINTS} onReload={noop} now={NOW} />);
    for (const k of [...LAYOUT, ...ROWS, ...STATS_ROW]) expect(html, k).toContain(k);
    expect(html).toContain('acct31@example.test');          // the login is the title
    expect(html).toContain('worker-60-14-1');
    expect(html).toContain('fleetNoteSearching');            // what it is doing now
    expect(html).toContain('ff-live');                       // Live
    expect(html).toContain('Decodo NY 1');                   // the listed proxy, by label
    expect(html).toContain('isp.example.net:10001');
    expect(html).toContain('Philadelphia, PA');               // a city chip
    expect(html).toContain('fleetCitiesNote');
    expect(html).toContain('fleetPacingBudget');
    expect(html).toContain('fleetDetailHost');
    expect(html).toContain('0.14.0');                         // build, behind the 0.14.7 release
    expect(html).toContain('fleetBuildBehind');
    expect(html).toContain('fbcWatchBrowser');
    expect(html).toContain('fleetPark');
    expect(html).toContain('fpRemoveFromFleet');
    expect(html).toContain('fleetSearchCityNow');
    expect(html).toContain('fleetHist_done');                 // history from task events
    expect(html).toContain('fbcHistSignOn');                  // and the pool stint
    expect(html).toContain('fbcNoCheckpoint');
    // Homelab-only actions are not offered.
    for (const k of ['fbcRelogin', 'fbcEditCreds', 'fbcEditCities', 'fbcQueueField']) expect(html).not.toContain(k);
    expect(html).not.toContain('password_enc');
  });

  it('shows a parked worker\'s wall as its open checkpoint', () => {
    const parked = { ...WORKER_DETAIL, worker: { ...WORKER_DETAIL.worker, state: 'CHECKPOINT', task: null, detail: { reason: 'wall', wall: 'checkpoint', url: 'https://www.facebook.com/checkpoint/9' } } };
    const html = renderToString(<ErpWorkerView detail={parked} stints={[]} onReload={noop} now={NOW} />);
    expect(html).toContain('ff-attention');
    expect(html).toContain('fbcAttnParked');
    expect(html).toContain('https://www.facebook.com/checkpoint/9');
    expect(html).not.toContain('fbcNoCheckpoint');
  });

  it('offers Unpark for a parked slot and reads "—" without a slot', () => {
    const html = renderToString(<ErpWorkerView detail={{ ...WORKER_DETAIL, holds_slot: false, slot: { ...WORKER_DETAIL.slot!, parked: true, worker_id: null } }} stints={[]} onReload={noop} now={NOW} />);
    expect(html).toContain('fleetUnpark');
    const bare = renderToString(<ErpWorkerView detail={{ ...WORKER_DETAIL, slot: null, proxy: null, account: null }} stints={null} onReload={noop} now={NOW} />);
    expect(bare).toContain('fleetSlotNone');
    expect(bare).toContain('fleetNoPoolAccount');
    expect(bare).not.toContain('fleetPark');
  });

  it('shows a homelab worker on the same layout', () => {
    const html = renderToString(<HomelabWorkerView workerId="homelab-5" fleet={COORDINATOR} challenges={[]} hits={HITS} marks={[]}
      stints={[]} logins={[]} cityLog={[]} onReload={noop} onMarks={noop} />);
    for (const k of [...LAYOUT, ...ROWS, ...STATS_ROW]) expect(html, k).toContain(k);
    expect(html).toContain('homelab-5');
    expect(html).toContain('Los Angeles');
    expect(html).toContain('fbcDetailVaultAccount');
    expect(html).toContain('fbcRelogin');                     // its own actions stay
    expect(html).toContain('fbcEditCreds');
  });

  it('still opens a retired homelab worker, dated and without a re-login', () => {
    const html = renderToString(<HomelabWorkerView workerId="homelab-20" fleet={COORDINATOR} challenges={[]} hits={HITS} marks={[]}
      stints={[]} logins={[]} cityLog={[]} onReload={noop} onMarks={noop} />);
    expect(html).toContain('homelab-20');
    expect(html).toContain('fleetRetiredOn');
    expect(html).not.toContain('fbcRelogin');
    expect(html).not.toContain('fbcWorkerMissing');
  });
});
