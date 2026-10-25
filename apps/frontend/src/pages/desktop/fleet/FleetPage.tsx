import type { ReactNode } from 'react';
import type { FleetTab } from '../../../lib/route';
import { FleetAccountsTab } from './FleetAccountsTab';
import { FleetAnalysisTab } from './FleetAnalysisTab';
import { FleetCitiesTab } from './FleetCitiesTab';
import { FleetTasksTab } from './FleetTasksTab';
import '../../../styles/facebookPool.css';
import '../../../styles/fleet.css';

// ─── Monitors ▸ Facebook: the fleet tabs ──────────────────────────────────────
// Fleet (the hosts and every account), Tasks (the belt and the task table),
// Cities (the catalog) and Analysis (the search-to-alert pipeline) read the
// ERP's own fleet tables through /api/fleet, plus the coordinator's proxy
// where it still knows something the ERP does not; Account pool beside them
// stays as it is. Desktop only: the sidebar entry is a manager's, and the
// tables are wide.

export function FleetTabPage({ tab, head, tabs }: { tab: FleetTab | 'fleet'; head: ReactNode; tabs: ReactNode }) {
  return <>
    {head}
    {tabs}
    {tab === 'fleet' && <FleetAccountsTab />}
    {tab === 'tasks' && <FleetTasksTab />}
    {tab === 'cities' && <FleetCitiesTab />}
    {tab === 'analysis' && <FleetAnalysisTab />}
  </>;
}
