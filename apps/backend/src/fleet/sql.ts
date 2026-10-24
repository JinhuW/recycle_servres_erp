import { createHash } from 'node:crypto';
import type { SqlLike } from '../db';

// Row shapes and the few queries more than one fleet module runs. Handlers keep
// their own SQL next to the route; this is only what auth and health share.

/** Every relation the fleet migration creates, the view included. */
export const FLEET_TABLES = [
  'fleet_cities',
  'fleet_hosts',
  'fleet_items',
  'fleet_minutes',
  'fleet_settings',
  'fleet_slots',
  'fleet_task_events',
  'fleet_tasks',
  'fleet_workers',
] as const;

export type FleetHostRow = {
  host_id: string;
  token_hash: string;
  capacity: number;
  authoritative: boolean;
  version: string | null;
  last_seen_at: Date | null;
  report: unknown;
  created_at: Date;
};

export type FleetSlotRow = {
  account_no: number;
  worker_id: string | null;
  host_id: string | null;
  last_host_id: string | null;
  epoch: number;
  lease_expires_at: Date | null;
  proxy_url: string | null;
  device: unknown;
  home_cities: string[];
  quarantined_until: Date | null;
  note: string;
};

export const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The fleet relations present in this database, sorted; health compares it to FLEET_TABLES. */
export async function fleetTablesPresent(sql: SqlLike): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name LIKE 'fleet\_%'
    ORDER BY table_name`;
  return rows.map((r) => r.table_name);
}

export async function loadHostByTokenHash(sql: SqlLike, hash: string): Promise<FleetHostRow | null> {
  const rows = await sql<FleetHostRow[]>`SELECT * FROM fleet_hosts WHERE token_hash = ${hash}`;
  return rows[0] ?? null;
}

export async function loadSlot(sql: SqlLike, accountNo: number): Promise<FleetSlotRow | null> {
  const rows = await sql<FleetSlotRow[]>`SELECT * FROM fleet_slots WHERE account_no = ${accountNo}`;
  return rows[0] ?? null;
}
