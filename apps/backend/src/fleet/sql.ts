import { createHash } from 'node:crypto';
import type { FleetError, FleetTask, FleetTaskEvent } from '@recycle-erp/shared';
import type { SqlLike } from '../db';

// Row shapes and the few queries more than one fleet module runs. Handlers keep
// their own SQL next to the module that owns the table; this is only what
// several of them share: auth and health, the task row every module reads, and
// the refusal shape every manager route answers with.

/** A refused manager request: the status and the contract's error body. */
export type Refusal = { status: 404 | 409 | 422; body: FleetError };

export const bad = (detail: string): Refusal => ({ status: 422, body: { error: 'bad_request', detail } });
export const notFound = (detail: string): Refusal => ({ status: 404, body: { error: 'not_found', detail } });
export const exists = (detail: string): Refusal => ({ status: 409, body: { error: 'exists', detail } });

export const isRefusal = (v: unknown): v is Refusal =>
  typeof v === 'object' && v !== null && 'status' in v && 'body' in v
  && typeof (v as Refusal).body === 'object' && 'error' in (v as Refusal).body;

export const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** fleet_tasks as postgres.js returns it: the BIGSERIAL id arrives as a string. */
export type TaskRow = {
  id: string;
  city: string;
  item: string;
  kind: FleetTask['kind'];
  due_at: Date;
  priority: number;
  state: FleetTask['state'];
  worker_id: string | null;
  account_no: number | null;
  epoch: number | null;
  leased_at: Date | null;
  lease_expires_at: Date | null;
  started_at: Date | null;
  done_at: Date | null;
  reason: FleetTask['reason'];
  result: FleetTask['result'];
};

export type TaskEventRow = {
  id: string;
  task_id: string | null;
  worker_id: string | null;
  kind: FleetTaskEvent['kind'];
  detail: FleetTaskEvent['detail'];
  at: Date;
};

export const taskToWire = (r: TaskRow): FleetTask => ({
  id: Number(r.id),
  city: r.city,
  item: r.item,
  kind: r.kind,
  due_at: r.due_at.toISOString(),
  priority: r.priority,
  state: r.state,
  worker_id: r.worker_id,
  account_no: r.account_no,
  epoch: r.epoch,
  leased_at: iso(r.leased_at),
  lease_expires_at: iso(r.lease_expires_at),
  started_at: iso(r.started_at),
  done_at: iso(r.done_at),
  reason: r.reason,
  result: r.result,
});

export const eventToWire = (r: TaskEventRow): FleetTaskEvent => ({
  id: Number(r.id),
  task_id: r.task_id === null ? null : Number(r.task_id),
  worker_id: r.worker_id,
  kind: r.kind,
  detail: r.detail,
  at: r.at.toISOString(),
});

/** Every relation the fleet migration creates, the view included. */
export const FLEET_TABLES = [
  'fleet_cities',
  'fleet_claim_tickets',
  'fleet_hosts',
  'fleet_items',
  'fleet_minutes',
  'fleet_settings',
  'fleet_slots',
  'fleet_task_attempts',
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
  quarantine_reset_at: Date | null;
  handoff_epoch: number | null;
  claim_id: string | null;
  /** A handoff reservation's deadline; the lease ends with it. */
  reserved_until: Date | null;
  note: string;
};

/** A claim ticket as stored: only its hash, the worker it is for, and whether a claim spent it. */
export type ClaimTicketRow = {
  token_hash: string;
  host_id: string;
  worker_id: string;
  handoff_epoch: number | null;
  expires_at: Date;
  consumed_at: Date | null;
  claim_id: string | null;
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
