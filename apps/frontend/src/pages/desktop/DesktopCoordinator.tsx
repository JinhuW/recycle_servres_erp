import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { coordinatorApi, type Challenge, type FleetDoc } from '../../lib/coordinator';
import { handleFetchError } from '../../lib/errorToast';
import { fleetApi, type FleetSlot } from '../../lib/fleet';
import { useT } from '../../lib/i18n';
import {
  FLEET_TABS, fleetRedirect, fleetTabPath, hrefFor, matchFleetTab, matchFleetWatch, matchFleetWorker, onLinkClick, replaceRoute, useRoute,
  type FleetTab,
} from '../../lib/route';
import { useEffectiveUser } from '../../lib/tweaks';
import { poolApi, type PoolSnapshot } from '../../lib/facebookPool';
import { FacebookAccountPool } from './FacebookAccountPool';
import { FormSkeleton } from '../../components/Skeleton';
import { fleetRows, fleetRunning } from './fleet/fleetRows';
import { useFleetPoll } from './fleet/shared';

// The viewer carries noVNC; it is its own chunk, fetched only when a manager
// actually opens a worker's browser, and it too decides between the ERP's
// fleet and the coordinator (pages/desktop/fleet/FleetWatchSwitch.tsx). The
// worker page is its own chunk too.
const FleetWatch = lazy(() => import('./fleet/FleetWatchSwitch').then(m => ({ default: m.FleetWatchSwitch })));
// The worker page decides between the ERP's own fleet worker and the
// coordinator's (pages/desktop/fleet/FleetWorkerSwitch.tsx).
const FleetWorker = lazy(() => import('./fleet/FleetWorkerSwitch').then(m => ({ default: m.FleetWorkerSwitch })));
// The fleet tabs: their tables and dialogs are one chunk together.
const FleetTabPage = lazy(() => import('./fleet/FleetPage').then(m => ({ default: m.FleetTabPage })));

// ─── Monitors ▸ Facebook ──────────────────────────────────────────────────────
// Five tabs in one chrome, managers only except the last: Fleet (the hosts
// and every account), Tasks (the belt and the task table), Cities (the
// catalog), Analysis (the search-to-alert pipeline) and Account pool (the
// accounts purchasers take, FacebookAccountPool.tsx). The fleet tabs read
// /api/fleet (pages/desktop/fleet/*) and, until cutover, the coordinator
// through the /api/coordinator proxy; the tab bar's count chips come from the
// same calls. Purchasers see Account pool alone.

const COUNTS_MS = 30_000;

type TabIcon = 'shield' | 'clock' | 'globe' | 'analytics' | 'users';
const FLEET_TAB_TITLE: Record<FleetTab, string> = { tasks: 'fleetTasksTitle', cities: 'fleetCitiesTitle', analysis: 'fleetAnalysisTitle' };
const TAB_ICON: Record<FleetTab, TabIcon> = { tasks: 'clock', cities: 'globe', analysis: 'analytics' };

type Props = { showToast?: (msg: string, kind?: 'success' | 'error') => void };

export function DesktopCoordinator({ showToast }: Props) {
  const { path } = useRoute();
  const user = useEffectiveUser();
  const { t } = useT();
  const [pool, setPool] = useState<PoolSnapshot | null>(null);
  const manager = user?.role === 'manager';
  const fleetTab: FleetTab | null = manager ? matchFleetTab(path) : null;
  const poolOpen = !manager || path === '/fleet/pool';
  const watch = manager ? matchFleetWatch(path) : null;
  const worker = manager ? matchFleetWorker(path) : null;
  // The tabs that went away still have their old paths bookmarked.
  useEffect(() => {
    const to = fleetRedirect(path);
    if (to) replaceRoute(to);
  }, [path]);
  // The snapshot unseals every secret of every row, so only the Pool tab
  // reads it; the other tabs' count chip comes from the pool summary. Once
  // read it stays, and the Pool tab keeps it current from its writes.
  const wantPool = poolOpen && !pool;
  useEffect(() => {
    if (wantPool) poolApi.snapshot().then(setPool).catch(handleFetchError);
  }, [wantPool]);
  // A fleet account's holder is a worker: the Pool tab links it and shows its
  // health. Without the coordinator those rows read as plain text.
  const [fleet, setFleet] = useState<FleetDoc | null>(null);
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [slots, setSlots] = useState<FleetSlot[] | null>(null);
  const loadSlots = useCallback(() => { fleetApi.slots().then(setSlots).catch(() => undefined); }, []);
  useEffect(() => {
    if (!manager || !poolOpen) return;
    coordinatorApi.fleet().then(setFleet).catch(() => undefined);
    coordinatorApi.listOpenChallenges().then(setChallenges).catch(() => undefined);
    loadSlots();
  }, [manager, poolOpen, loadSlots]);
  const counts = useTabCounts(manager && !watch && !worker);
  if (watch) {
    return (
      <Suspense fallback={<FormSkeleton fields={4} />}>
        <FleetWatch key={watch.workerId} workerId={watch.workerId} />
      </Suspense>
    );
  }
  if (worker) {
    return (
      <Suspense fallback={<FormSkeleton fields={6} />}>
        <FleetWorker key={worker.workerId} workerId={worker.workerId} />
      </Suspense>
    );
  }
  const fleetOpen = !poolOpen && !fleetTab;
  const chip = (n: number | null, hot = false) => n === null ? null : <span className={`chip muted${hot && n > 0 ? ' fleet-chip-hot' : ''}`}>{n}</span>;
  const tabs = manager ? <nav className="tabs fp-view-tabs" aria-label={t('fpViews')}>
    <a className={`tab ${fleetOpen ? 'active' : ''}`} href={hrefFor('/fleet')} onClick={onLinkClick('/fleet')} aria-current={fleetOpen ? 'page' : undefined}>
      <Icon name="shield" size={14} />{t('fpFleet')}{chip(counts.running)}
    </a>
    {FLEET_TABS.map(tab => (
      <a key={tab} className={`tab ${fleetTab === tab ? 'active' : ''}`} href={hrefFor(fleetTabPath(tab))} onClick={onLinkClick(fleetTabPath(tab))}
        aria-current={fleetTab === tab ? 'page' : undefined}>
        <Icon name={TAB_ICON[tab]} size={14} />{t(FLEET_TAB_TITLE[tab])}
        {tab === 'tasks' && chip(counts.due, true)}
        {tab === 'cities' && chip(counts.cities)}
      </a>
    ))}
    <a className={`tab ${poolOpen ? 'active' : ''}`} href={hrefFor('/fleet/pool')} onClick={onLinkClick('/fleet/pool')} aria-current={poolOpen ? 'page' : undefined}>
      <Icon name="users" size={14} />{t('fpPool')}{chip(pool ? pool.accounts.length : counts.pool)}
    </a>
  </nav> : null;
  const head = (
    <div className="page-head"><div><div className="page-sub">{t('nav_monitors')} / {t('nav_coordinator')}</div>
      <h1 className="page-title">{t('fbcFleetTitle')}</h1></div></div>
  );
  if (poolOpen) {
    return <>
      {head}
      {tabs}
      {pool
        ? <FacebookAccountPool key={user?.role} snapshot={pool} onSnapshot={setPool} showToast={showToast}
            fleet={manager ? fleet : null} challenges={challenges} slots={manager ? slots : null} onSlotsChanged={loadSlots} />
        : <FormSkeleton fields={4} />}
    </>;
  }
  return (
    <Suspense fallback={<>{head}{tabs}<FormSkeleton fields={4} /></>}>
      <FleetTabPage key={fleetTab ?? 'fleet'} tab={fleetTab ?? 'fleet'} head={head} tabs={tabs} />
    </Suspense>
  );
}

type TabCounts = { running: number | null; due: number | null; cities: number | null; pool: number | null };
const NO_COUNTS: TabCounts = { running: null, due: null, cities: null, pool: null };

// The tab bar's chips: running workers (ERP and coordinator), tasks due now,
// cities, pool accounts. Read on its own clock, slower than the tabs, since
// each tab reads what it shows itself; the reads it shares with the open tab
// go out once (lib/sharedGet.ts). The ERP's counts show at once, the running
// count once the coordinator has answered too, so it never jumps.
function useTabCounts(on: boolean): TabCounts {
  const { data: erp } = useFleetPoll(() => {
    if (!on) return Promise.resolve(null);
    const now = Date.now();
    return Promise.all([
      fleetApi.slots(), fleetApi.workers(), fleetApi.tasks({ state: 'ready' }), fleetApi.cities(),
      poolApi.summary().then(s => s.accounts).catch(() => null),
    ]).then(([slots, workers, ready, cities, pool]) => ({
      slots, workers, pool,
      due: ready.filter(x => x.kind === 'search' && Date.parse(x.due_at) <= now).length,
      cities: cities.length,
    }));
  }, COUNTS_MS);
  const { data: coord } = useFleetPoll(() => {
    if (!on) return Promise.resolve(null);
    return Promise.all([coordinatorApi.fleet().catch(() => null), coordinatorApi.listOpenChallenges().catch(() => null)])
      .then(([coordinator, challenges]) => ({ coordinator, challenges }));
  }, COUNTS_MS);
  return useMemo(() => {
    if (!erp || erp === 'unavailable') return NO_COUNTS;
    const c = coord && coord !== 'unavailable' ? coord : null;
    const running = c
      ? fleetRunning(fleetRows({ slots: erp.slots, workers: erp.workers, release: null, pool: erp.pool, ...c }, Date.now())).running
      : null;
    return { running, due: erp.due, cities: erp.cities, pool: erp.pool?.length ?? null };
  }, [erp, coord]);
}
