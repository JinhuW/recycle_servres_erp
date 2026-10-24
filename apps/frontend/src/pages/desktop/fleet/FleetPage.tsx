import type { ReactNode } from 'react';
import type { FleetTab } from '../../../lib/route';
import { FleetCitiesTab } from './FleetCitiesTab';
import { FleetHostsTab } from './FleetHostsTab';
import { FleetQueueTab } from './FleetQueueTab';
import { FleetSlotsTab } from './FleetSlotsTab';
import '../../../styles/facebookPool.css';
import '../../../styles/fleet.css';

// ─── Monitors ▸ Facebook: the ERP-owned fleet tabs ────────────────────────────
// Cities, Queue, Hosts and Slots read the ERP's own fleet tables through
// /api/fleet; the Fleet and Account pool tabs beside them stay as they are.
// Desktop only: the sidebar entry is a manager's, and the tables are wide.

export const FLEET_TAB_TITLE: Record<FleetTab, string> = {
  cities: 'fleetCitiesTitle', queue: 'fleetQueueTitle', hosts: 'fleetHostsTitle', slots: 'fleetSlotsTitle',
};

export function FleetTabPage({ tab, head, tabs }: { tab: FleetTab; head: ReactNode; tabs: ReactNode }) {
  return <>
    {head}
    {tabs}
    {tab === 'cities' && <FleetCitiesTab />}
    {tab === 'queue' && <FleetQueueTab />}
    {tab === 'hosts' && <FleetHostsTab />}
    {tab === 'slots' && <FleetSlotsTab />}
  </>;
}
