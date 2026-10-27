import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { FormSkeleton } from '../../../components/Skeleton';
import { ApiError } from '../../../lib/api';
import { poolApi, type FbWorkerStint } from '../../../lib/facebookPool';
import { fleetApi } from '../../../lib/fleet';
import { ErpWorkerView } from './FleetErpWorker';
import { useFleetPoll } from './shared';
import '../../../styles/facebookPool.css';
import '../../../styles/fleet.css';

// ─── One worker: fleet or coordinator ─────────────────────────────────────────
// /fleet/worker/<id> serves both kinds, on one layout (workerDetail.tsx). A
// worker the ERP's fleet knows (it claimed a slot here) gets the ERP's page,
// read in one call; any id the fleet never saw (404) falls through to the
// coordinator's worker page, which is what the route always showed.

const CoordinatorWorker = lazy(() => import('../FleetWorker').then(m => ({ default: m.FleetWorker })));

const NOT_FLEET = 'not_fleet' as const;

export function FleetWorkerSwitch({ workerId }: { workerId: string }) {
  const load = useCallback(() => fleetApi.worker(workerId)
    .catch(err => (err instanceof ApiError && err.status === 404 ? NOT_FLEET : Promise.reject(err))), [workerId]);
  const { data, reload } = useFleetPoll(load);
  const [stints, setStints] = useState<FbWorkerStint[] | null>(null);
  const fleetWorker = data !== null && data !== 'unavailable' && data !== NOT_FLEET;
  const readStints = useCallback(() => {
    poolApi.workerAccounts(workerId).then(r => setStints(r.stints)).catch(() => setStints([]));
  }, [workerId]);
  useEffect(() => { if (fleetWorker) readStints(); }, [fleetWorker, readStints]);

  if (data === null) return <FormSkeleton fields={6} />;
  if (!fleetWorker) {
    return (
      <Suspense fallback={<FormSkeleton fields={6} />}>
        <CoordinatorWorker key={workerId} workerId={workerId} />
      </Suspense>
    );
  }
  return <ErpWorkerView detail={data} stints={stints} onReload={() => { reload(); readStints(); }} />;
}
