import { lazy, Suspense, useEffect, useState } from 'react';
import { FormSkeleton } from '../../../components/Skeleton';
import { fleetApi, type FleetWorkerDetail } from '../../../lib/fleet';
import { FleetErpWatch } from './FleetErpWatch';
import '../../../styles/facebookPool.css';
import '../../../styles/fleet.css';

// ─── Watch a worker: fleet or coordinator ─────────────────────────────────────
// /fleet/watch/<id> serves both kinds on one page (watchView.tsx), as
// /fleet/worker/<id> does (FleetWorkerSwitch.tsx). A worker the ERP's fleet
// knows gets the fleet's feed; any id it never saw, or a fleet that cannot be
// read, falls through to the coordinator's, which is what the route always
// showed. Asked once: the kind of a worker does not change under the page.

const FleetWatch = lazy(() => import('../FleetWatch').then(m => ({ default: m.FleetWatch })));

export function FleetWatchSwitch({ workerId }: { workerId: string }) {
  const [found, setFound] = useState<FleetWorkerDetail | 'coordinator' | null>(null);
  useEffect(() => {
    let live = true;
    fleetApi.worker(workerId)
      .then(d => { if (live) setFound(d); })
      .catch(() => { if (live) setFound('coordinator'); });
    return () => { live = false; };
  }, [workerId]);

  if (found === null) return <FormSkeleton fields={4} />;
  if (found === 'coordinator') {
    return (
      <Suspense fallback={<FormSkeleton fields={4} />}>
        <FleetWatch key={workerId} workerId={workerId} />
      </Suspense>
    );
  }
  return <FleetErpWatch initial={found} />;
}
