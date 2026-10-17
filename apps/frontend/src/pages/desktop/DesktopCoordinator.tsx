import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon';
import { ApiError } from '../../lib/api';
import {
  coordinatorApi,
  type AlertHitRow,
  type Challenge,
  type FilterPrompt,
  type FleetDoc,
  type ReviewStatsDay,
} from '../../lib/coordinator';
import { handleFetchError } from '../../lib/errorToast';
import { FLEET_STATUSES, fleetStatus, parkedWorkers, type FleetStatus } from '../../lib/fleetView';
import { useT } from '../../lib/i18n';
import { hrefFor, matchFleetWatch, matchFleetWorker, onLinkClick, useRoute } from '../../lib/route';
import { useEffectiveUser } from '../../lib/tweaks';
import { poolApi, type PoolSnapshot } from '../../lib/facebookPool';
import { FacebookAccountPool } from './FacebookAccountPool';
import { FormSkeleton } from '../../components/Skeleton';
import { HITS_DAYS } from './FleetAccounts';
import { FlowCard } from './FleetFlow';
import { ActivityAside, FleetLegend, WorkersCard } from './FleetWorkers';

// The viewer carries noVNC; it is its own chunk, fetched only when a manager
// actually opens a worker's browser. The worker page is its own chunk too.
const FleetWatch = lazy(() => import('./FleetWatch').then(m => ({ default: m.FleetWatch })));
const FleetWorker = lazy(() => import('./FleetWorker').then(m => ({ default: m.FleetWorker })));

// ─── Monitors ▸ Facebook ──────────────────────────────────────────────────────
// Two tabs in one chrome. Fleet (managers only): the status legend, the
// workers table with the activity aside, and the pipeline from a search to an
// alert; the eye on a row opens that worker's page (FleetWorker.tsx). Account
// pool: the accounts purchasers take (FacebookAccountPool.tsx). Everything
// live goes through the /api/coordinator proxy; a 501 from it means the
// backend has no control-plane credentials, which gets its own quiet state
// instead of error toasts.

const REFRESH_MS = 30_000;
const STATS_DAYS = 14;

// Data either arrives or the card shows its own empty state — never an error
// dialog: this page must stay a non-blocker for the rest of the ERP.
type Unavailable = 'unavailable';

type Props = { showToast?: (msg: string, kind?: 'success' | 'error') => void };

export function DesktopCoordinator({ showToast }: Props) {
  const { path } = useRoute();
  const user = useEffectiveUser();
  const { t } = useT();
  const [pool, setPool] = useState<PoolSnapshot | null>(null);
  const manager = user?.role === 'manager';
  const poolOpen = !manager || path === '/fleet/pool';
  const watch = manager ? matchFleetWatch(path) : null;
  const worker = manager ? matchFleetWorker(path) : null;
  // Loaded on both tabs: the Pool tab's count chip reads it too.
  useEffect(() => {
    poolApi.snapshot().then(setPool).catch(handleFetchError);
  }, []);
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
  const tabs = manager ? <nav className="tabs fp-view-tabs" aria-label={t('fpViews')}>
    <a className={`tab ${!poolOpen ? 'active' : ''}`} href={hrefFor('/fleet')} onClick={onLinkClick('/fleet')} aria-current={!poolOpen ? 'page' : undefined}><Icon name="shield" size={14} />{t('fpFleet')}</a>
    <a className={`tab ${poolOpen ? 'active' : ''}`} href={hrefFor('/fleet/pool')} onClick={onLinkClick('/fleet/pool')} aria-current={poolOpen ? 'page' : undefined}><Icon name="users" size={14} />{t('fpPool')}{pool && <span className="chip muted">{pool.accounts.length}</span>}</a>
  </nav> : null;
  const head = (
    <div className="page-head"><div><div className="page-sub">{t('nav_monitors')} / {t('nav_coordinator')}</div>
      <h1 className="page-title">{poolOpen ? t('fpTitle') : t('fbcFleetTitle')}</h1></div></div>
  );
  return poolOpen ? <>
    {head}
    {tabs}
    {pool
      ? <FacebookAccountPool key={user?.role} snapshot={pool} onSnapshot={setPool} showToast={showToast} />
      : <FormSkeleton fields={4} />}
  </> : <FleetPage head={head} tabs={tabs} />;
}

function FleetPage({ head, tabs }: { head: React.ReactNode; tabs: React.ReactNode }) {
  const { t, locale } = useT();

  const [fleet, setFleet] = useState<FleetDoc | null>(null);
  // The fleet document needs a facade that knows /v1/fleet. An older facade
  // (404) or an unreachable one (502) must not take the rest of the page
  // down, so only "proxy unconfigured" (501) is fatal here; anything else
  // leaves the fleet cards in their own unavailable state.
  const [fleetUnavailable, setFleetUnavailable] = useState(false);
  const [hits, setHits] = useState<AlertHitRow[] | null>(null);
  const [challenges, setChallenges] = useState<Challenge[] | null>(null);
  const [stats, setStats] = useState<ReviewStatsDay[] | Unavailable | null>(null);
  const [prompt, setPrompt] = useState<FilterPrompt | Unavailable | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const [filter, setFilter] = useState<FleetStatus | 'all'>('all');

  const fail = useCallback((err: unknown) => {
    // 501 = proxy env vars unset; 404 = a backend that predates the proxy
    // route entirely. Both mean "no control plane here", not an error.
    if (err instanceof ApiError && (err.status === 501 || err.status === 404)) {
      setNotConfigured(true);
      return;
    }
    handleFetchError(err);
  }, []);

  const load = useCallback(() => {
    coordinatorApi.fleet()
      .then(doc => { setFleet(doc); setFleetUnavailable(false); })
      .catch(err => {
        if (err instanceof ApiError && err.status === 501) { fail(err); return; }
        setFleetUnavailable(true);
      });
    coordinatorApi.listOpenChallenges().then(setChallenges).catch(fail);
    // Per-city alert counts decorate the table; without them it still
    // renders, just without the numbers.
    coordinatorApi.alertHits(HITS_DAYS).then(setHits).catch(() => setHits([]));
    // Stats and prompt only feed the flow card; it shows "—" without them.
    coordinatorApi.reviewStats(STATS_DAYS)
      .then(setStats)
      .catch(() => setStats('unavailable'));
    coordinatorApi.filterPrompt()
      .then(p => setPrompt(p.prompt ? p : 'unavailable'))
      .catch(() => setPrompt('unavailable'));
  }, [fail]);

  useEffect(() => { load(); }, [load]);

  // Liveness and queue age both move on their own, so the whole page refetches
  // on a timer rather than waiting for a navigation.  A backgrounded tab polls
  // nothing and catches up the moment it's back.
  useEffect(() => {
    const refresh = () => { if (!document.hidden) load(); };
    const timer = setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const counts = useMemo(() => {
    const parked = parkedWorkers(challenges);
    const out = Object.fromEntries(FLEET_STATUSES.map(s => [s, 0])) as Record<FleetStatus, number>;
    for (const w of fleet?.workers ?? []) out[fleetStatus(w, parked)] += 1;
    return out;
  }, [fleet, challenges]);

  return (
    <div className="fp-pool">
      <div>{head}{tabs}</div>
      {notConfigured ? (
        <div className="card">
          <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', color: 'var(--fg-muted)' }}>
            <Icon name="info" size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <span style={{ maxWidth: '65ch' }}>{t('fbcNotConfigured')}</span>
          </div>
        </div>
      ) : (
        <>
          <FleetLegend counts={counts} filter={filter} onFilter={setFilter} />
          <div className="fp-split ff-split">
            <WorkersCard fleet={fleet} unavailable={fleetUnavailable} hits={hits} challenges={challenges}
              filter={filter} onClearFilter={() => setFilter('all')} locale={locale} />
            <ActivityAside fleet={fleet} challenges={challenges} locale={locale} />
          </div>
          <FlowCard fleet={fleet} stats={stats} prompt={prompt} onSaved={load} />
        </>
      )}
    </div>
  );
}
