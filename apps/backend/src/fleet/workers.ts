import { Hono } from 'hono';
import type { FleetSlot, FleetTask, FleetWorker } from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { log } from '../lib/log';
import { releaseTasks } from './claim';
import { loadSettings } from './cities';
import { managerOnly, type ManagerEnv } from './auth';
import { taskToWire, type TaskRow } from './sql';

// ─── Slots and workers, as the manager sees them ──────────────────────────────
// A slot is one pool account's place in the fleet; a worker is the container
// running it. Both are read together with the task in hand, so the Slots tab
// can say who searches what, how much of today's budget is spent and which
// accounts sit in quarantine. The two writes a manager has here are to lift a
// quarantine early and to park an account: the parked slot keeps an infinite
// lease with no worker, so nothing claims it, and its epoch moves on so the
// worker on it is refused and exits.

const slots = new Hono<ManagerEnv>().use('*', managerOnly);
const workers = new Hono<ManagerEnv>().use('*', managerOnly);

const wlog = log.child({ module: 'fleet' });
const iso = (d: Date | null) => (d === null || !Number.isFinite(d.getTime()) ? null : d.toISOString());
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type SlotRow = {
  account_no: number; worker_id: string | null; host_id: string | null; last_host_id: string | null; epoch: number;
  lease_expires_at: Date | null; proxy_url: string | null; device: unknown; home_cities: unknown;
  quarantined_until: Date | null; note: string; parked: boolean;
  uid: string | null; pool_status: string; minutes_today: number;
};

type WorkerRow = {
  worker_id: string; host_id: string | null; account_no: number | null; epoch: number | null; state: string | null;
  version: string | null; last_heartbeat_at: Date | null; vnc_port: number | null; detail: unknown;
};

type WorkerView = FleetWorker & { task: (FleetTask & { city_name: string | null }) | null };
type SlotView = FleetSlot & { uid: string | null; pool_status: string; minutes_today: number; budget_minutes: number; worker: WorkerView | null };

const SLOT_SELECT = (sql: SqlLike) => sql`
  SELECT s.account_no, s.worker_id, s.host_id, s.last_host_id, s.epoch, s.lease_expires_at, s.proxy_url, s.device,
         s.home_cities, s.quarantined_until, s.note,
         (s.lease_expires_at IS NOT DISTINCT FROM 'infinity'::timestamptz) AS parked,
         a.uid, a.status AS pool_status,
         COALESCE((SELECT m.minutes::float8 FROM fleet_minutes m
                   WHERE m.account_no = s.account_no AND m.day = (NOW() AT TIME ZONE 'UTC')::date), 0) AS minutes_today
  FROM fleet_slots s JOIN fb_pool_accounts a ON a.no = s.account_no`;

/** Every worker row with the task it holds, keyed by worker id. */
async function workerViews(sql: SqlLike): Promise<Map<string, WorkerView>> {
  const rows = await sql<WorkerRow[]>`SELECT * FROM fleet_workers ORDER BY worker_id`;
  const tasks = await sql<(TaskRow & { city_name: string | null })[]>`
    SELECT t.*, c.name AS city_name FROM fleet_tasks t LEFT JOIN fleet_cities c ON c.slug = t.city
    WHERE t.state = 'leased' AND t.worker_id IS NOT NULL`;
  const byWorker = new Map(tasks.map((t) => [t.worker_id!, { ...taskToWire(t), city_name: t.city_name }]));
  return new Map(rows.map((w) => [w.worker_id, {
    ...w,
    last_heartbeat_at: iso(w.last_heartbeat_at),
    detail: isRecord(w.detail) ? w.detail : null,
    task: byWorker.get(w.worker_id) ?? null,
  }]));
}

function slotView(r: SlotRow, budget: number, workersById: Map<string, WorkerView>): SlotView {
  const device = isRecord(r.device) ? r.device : null;
  return {
    account_no: r.account_no,
    worker_id: r.worker_id,
    host_id: r.host_id,
    last_host_id: r.last_host_id,
    epoch: r.epoch,
    lease_expires_at: r.parked ? null : iso(r.lease_expires_at),
    has_proxy: r.proxy_url !== null,
    device: device as FleetSlot['device'],
    home_cities: Array.isArray(r.home_cities) ? (r.home_cities as string[]) : [],
    quarantined_until: iso(r.quarantined_until),
    note: r.note,
    parked: r.parked,
    uid: r.uid,
    pool_status: r.pool_status,
    minutes_today: Math.round(r.minutes_today),
    budget_minutes: budget,
    worker: r.worker_id ? workersById.get(r.worker_id) ?? null : null,
  };
}

async function loadSlotView(sql: SqlLike, no: number): Promise<SlotView | null> {
  const [row] = await sql<SlotRow[]>`${SLOT_SELECT(sql)} WHERE s.account_no = ${no}`;
  if (!row) return null;
  const [settings, byWorker] = [await loadSettings(sql), await workerViews(sql)];
  return slotView(row, settings.budget_minutes, byWorker);
}

function parseNo(raw: string): number | null {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

slots.get('/', async (c) => {
  const sql = getDb(c.env);
  const rows = await sql<SlotRow[]>`${SLOT_SELECT(sql)} ORDER BY s.account_no`;
  const settings = await loadSettings(sql);
  const byWorker = await workerViews(sql);
  return c.json({ slots: rows.map((r) => slotView(r, settings.budget_minutes, byWorker)) });
});

slots.post('/:no/release-quarantine', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'not_found' }, 404);
  const sql = getDb(c.env);
  const rows = await sql<{ account_no: number }[]>`
    UPDATE fleet_slots SET quarantined_until = NULL, quarantine_reset_at = NOW(), quarantine_evidence = NULL WHERE account_no = ${no} RETURNING account_no`;
  if (!rows.length) return c.json({ error: 'not_found' }, 404);
  wlog.info('fleet quarantine released', { accountNo: no, by: c.var.user.email });
  return c.json({ slot: await loadSlotView(sql, no) });
});

slots.post('/:no/park', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'not_found' }, 404);
  const sql = getDb(c.env);
  const found = await sql.begin(async (tx) => {
    await tx`SELECT no FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
    const rows = await tx<{ worker_id: string | null }[]>`
      SELECT worker_id FROM fleet_slots WHERE account_no = ${no} FOR UPDATE`;
    if (!rows.length) return false;
    await tx`
      UPDATE fleet_slots SET
        epoch = epoch + 1, worker_id = NULL, host_id = NULL, claim_id = NULL, handoff_epoch = NULL, lease_expires_at = 'infinity'::timestamptz
      WHERE account_no = ${no}`;
    const released = await releaseTasks(tx, { account_no: no }, 'parked');
    wlog.info('fleet slot parked', { accountNo: no, workerId: rows[0].worker_id, tasks: released, by: c.var.user.email });
    return true;
  });
  if (!found) return c.json({ error: 'not_found' }, 404);
  return c.json({ slot: await loadSlotView(sql, no) });
});

slots.post('/:no/unpark', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'not_found' }, 404);
  const sql = getDb(c.env);
  const rows = await sql<{ account_no: number }[]>`
    UPDATE fleet_slots SET lease_expires_at = NULL
    WHERE account_no = ${no} AND lease_expires_at = 'infinity'::timestamptz
    RETURNING account_no`;
  if (!rows.length) {
    const exists = await sql<{ account_no: number }[]>`SELECT account_no FROM fleet_slots WHERE account_no = ${no}`;
    if (!exists.length) return c.json({ error: 'not_found' }, 404);
  }
  wlog.info('fleet slot unparked', { accountNo: no, by: c.var.user.email });
  return c.json({ slot: await loadSlotView(sql, no) });
});

workers.get('/', async (c) => {
  const byWorker = await workerViews(getDb(c.env));
  return c.json({ workers: [...byWorker.values()] });
});

export { slots, workers };
