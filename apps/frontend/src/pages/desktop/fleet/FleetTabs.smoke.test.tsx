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
vi.mock('../../../lib/errorToast', () => ({ handleFetchError: vi.fn(), showSuccessToast: vi.fn() }));

const { CITIES, CITY_LOG, HOSTS, NOW, RELEASE, SLOTS, TASKS } = await import('./fixtures');
const { CitiesTable } = await import('./FleetCitiesTab');
const { CityLogTable, QueueBoard, TaskTable } = await import('./FleetQueueTab');
const { HostsTable, ReleaseBanner } = await import('./FleetHostsTab');
const { SlotsTable } = await import('./FleetSlotsTab');
const { FleetWorkerPage } = await import('./FleetWorkerSwitch');
const { WORKERS } = await import('./fixtures');
const { EMPTY_TASK_FILTER, withCityNames } = await import('./fleetBoard');

const noop = () => undefined;
const items = ['server_ram', 'enterprise_ssd'];

describe('Cities tab', () => {
  it('lists every city with its standing and the actions a row offers', () => {
    const html = renderToString(<CitiesTable cities={CITIES} items={items} onChanged={noop} now={NOW} />);
    expect(html).toContain('Houston, TX');
    expect(html).toContain('fleetCityVerifying');
    expect(html).toContain('fleetCityEnableAnyway');   // the verifying row
    expect(html).toContain('fleetCityRestore');        // the removed row
    expect(html).toContain('fleetSearchNow');
    expect(html).toContain('homelab-3');               // the holder of Houston's lease
    expect(html).toContain('facebook.com/marketplace/houston/');
    // The last-done column exists once per item.
    expect(html.match(/fleetColLastDone/g)?.length).toBe(2);
  });
  it('has an empty row without cities', () => {
    expect(renderToString(<CitiesTable cities={[]} items={items} onChanged={noop} now={NOW} />)).toContain('fleetCitiesNone');
  });
});

describe('Queue tab', () => {
  it('draws a board per item with a cell per city and the counts sentence', () => {
    const html = renderToString(<QueueBoard cities={CITIES} tasks={TASKS} items={items} onCity={noop} now={NOW} />);
    expect(html.match(/ff-round-item/g)?.length).toBe(2);
    expect(html).toContain('fleet-cell-leased');
    expect(html).toContain('fleet-cell-done');
    expect(html).toContain('fleet-cell-cancelled');
    expect(html).toContain('fleetBoardSearched');
  });
  it('lists tasks with their state chips and filters', () => {
    const html = renderToString(
      <TaskTable tasks={TASKS} items={items} filter={EMPTY_TASK_FILTER} onFilter={noop} onCity={noop} now={NOW} />,
    );
    expect(html).toContain('fleetState_leased');
    expect(html).toContain('fleetState_done');
    expect(html).toContain('fleetState_expired');
    expect(html).toContain('fleetKind_verify-slug');
    expect(html).toContain('fleetFilterAnyState');
    expect(html).toContain('fleetResultCards');   // a finished task's result
  });
  it('honours a filter', () => {
    const html = renderToString(
      <TaskTable tasks={withCityNames(TASKS, CITIES)} items={items} filter={{ ...EMPTY_TASK_FILTER, state: 'cancelled' }} onFilter={noop} onCity={noop} now={NOW} />,
    );
    expect(html).toContain('Tulsa, OK');
    expect(html).not.toContain('Houston, TX');
    expect(html).toContain('fleetFilterClear');
  });
  it('renders a city log with its rows folded', () => {
    const html = renderToString(<CityLogTable tasks={CITY_LOG} now={NOW} />);
    expect(html).toContain('homelab-1');
    expect(html).toContain('fleetState_done');
    expect(html).not.toContain('fleetEvent_handed');   // events show once a row is opened
  });
});

describe('Hosts tab', () => {
  it('shows each host’s switch, capacity, liveness and roll', () => {
    const html = renderToString(<HostsTable hosts={HOSTS} onChanged={noop} now={NOW} />);
    expect(html).toContain('homelab');
    expect(html).toContain('worker-60-14');
    expect(html).toContain('role="switch"');
    expect(html).toContain('fleetAuthoritativeOff');   // the observe-only host
    expect(html).toContain('fleetSeenNever');
    expect(html).toContain('fleetRollProgress');
    expect(html).toContain('1.340.0');
  });
  it('shows the latest roll from the hosts answer', () => {
    const html = renderToString(<ReleaseBanner release={RELEASE} now={NOW} />);
    expect(html).toContain('fleetReleaseState_rolling');
    expect(html).toContain('0.14.0');
    expect(html).toContain('fleetReleaseCounts');
    expect(html).toContain('fleetRollReplacing');
    const failed = renderToString(<ReleaseBanner release={{ ...RELEASE, state: 'failed', current: null, failure: 'homelab-3 did not come back' }} now={NOW} />);
    expect(failed).toContain('fleetReleaseState_failed');
    expect(failed).toContain('homelab-3 did not come back');
  });
});

describe('Slots tab', () => {
  it('masks uids and shows lease, budget and quarantine', () => {
    const html = renderToString(<SlotsTable slots={SLOTS} onChanged={noop} now={NOW} />);
    expect(html).not.toContain(SLOTS[0].uid!);
    expect(html).toContain('100…444');
    expect(html).toContain('fleetQuarantined');
    expect(html).toContain('fleetQuarantineRelease');
    expect(html).toContain('fleetPark');
    expect(html).toContain('ff-ring-full');            // #12 has used its budget
    expect(html).toContain('fpInFleet');
    expect(html).toContain('fpProblem');
  });
  it('shows a parked slot as parked with an Unpark action, not as free', () => {
    const html = renderToString(<SlotsTable slots={[SLOTS[8]]} onChanged={noop} now={NOW} />);
    expect(html).toContain('fleetLeaseParked');
    expect(html).toContain('fleetUnpark');
    expect(html).not.toContain('fleetLeaseNone');
    expect(html).not.toContain('>fleetPark<');
  });
});

describe('Worker page', () => {
  it('names the host, the account and the task a fleet worker holds', () => {
    const html = renderToString(<FleetWorkerPage worker={WORKERS[2]} />);
    expect(html).toContain('homelab-3');
    expect(html).toContain('#12');
    expect(html).toContain('Houston, TX');
    expect(html).toContain('fleetWatch');
  });
  it('says so when the worker holds no task', () => {
    expect(renderToString(<FleetWorkerPage worker={WORKERS[0]} />)).toContain('fleetTaskNone');
  });
});
