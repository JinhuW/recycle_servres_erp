import { Hono } from 'hono';
import {
  fleetDeviceFor, FLEET_SECRET_KINDS, type FleetSecretKind, type FleetSlot, type FleetTask, type FleetWorker, type FleetWorkerDetail,
} from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { log } from '../lib/log';
import { writeEvent } from '../routes/facebookPool';
import { WORKER_ID } from '../routes/coordinator';
import { releaseTasks } from './claim';
import { loadRelease } from './hosts';
import { cityLog } from './tasks';
import { CITY_SLUG, loadSettings } from './cities';
import { managerOnly, type ManagerEnv } from './auth';
import { bad, conflict, eventToWire, exists, isRefusal, notFound, taskToWire, type Refusal, type TaskEventRow, type TaskRow } from './sql';

// ─── Slots and workers, as the manager sees them ──────────────────────────────
// A slot is one pool account's place in the fleet; a worker is the container
// running it. Both are read together with the task in hand, so the Slots tab
// can say who searches what, how much of today's budget is spent and which
// accounts sit in quarantine. The two writes a manager has here are to lift a
// quarantine early and to park an account: the parked slot keeps an infinite
// lease with no worker, so nothing claims it, and its epoch moves on so the
// worker on it is refused and exits. A handoff reservation is not a park: it
// has its own deadline (reserved_until) and lapses by itself.
//
// A manager also puts a pool account into the fleet here (a slot on one of
// the listed proxies, fleet/proxies.ts) and takes it out again. The pool row
// turns `fleet` under the holder FLEET_HOLDER until a worker claims the slot
// and names itself; the pool's own triggers keep the stint ledger and fence
// the slot on any later change of owner.

const slots = new Hono<ManagerEnv>().use('*', managerOnly);
const workers = new Hono<ManagerEnv>().use('*', managerOnly);

const wlog = log.child({ module: 'fleet' });
const iso = (d: Date | null) => (d === null || !Number.isFinite(d.getTime()) ? null : d.toISOString());
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type SlotRow = {
  account_no: number; worker_id: string | null; host_id: string | null; last_host_id: string | null; epoch: number;
  lease_expires_at: Date | null; proxy_url: string | null; proxy_id: number | null; device: unknown; home_cities: unknown;
  quarantined_until: Date | null; note: string; parked: boolean; reserved_until: Date | null;
  uid: string | null; pool_status: string; minutes_today: number;
};

type WorkerRow = {
  worker_id: string; host_id: string | null; account_no: number | null; epoch: number | null; state: string | null;
  version: string | null; last_heartbeat_at: Date | null; vnc_port: number | null; detail: unknown;
};

type WorkerView = FleetWorker & { task: (FleetTask & { city_name: string | null }) | null };
type SlotView = FleetSlot & { uid: string | null; pool_status: string; minutes_today: number; budget_minutes: number; worker: WorkerView | null };

const SLOT_SELECT = (sql: SqlLike) => sql`
  SELECT s.account_no, s.worker_id, s.host_id, s.last_host_id, s.epoch, s.lease_expires_at, s.proxy_url, s.proxy_id, s.device,
         s.home_cities, s.quarantined_until, s.note,
         (s.lease_expires_at IS NOT DISTINCT FROM 'infinity'::timestamptz) AS parked,
         CASE WHEN s.reserved_until > NOW() THEN s.reserved_until END AS reserved_until,
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
    proxy_id: r.proxy_id,
    device: device as FleetSlot['device'],
    home_cities: Array.isArray(r.home_cities) ? (r.home_cities as string[]) : [],
    quarantined_until: iso(r.quarantined_until),
    note: r.note,
    parked: r.parked,
    reserved_until: iso(r.reserved_until),
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

// ─── Into and out of the fleet ────────────────────────────────────────────────

/** The pool holder a slot made here carries until a worker claims it. */
export const FLEET_HOLDER = 'ERP fleet';
const MAX_HOME_CITIES = 10;

type SlotWrite = { account_no: number; proxy_id: number; home_cities: string[] };

function readSlotWrite(input: unknown): SlotWrite | Refusal {
  if (!isRecord(input)) return bad('expected an object');
  for (const k of Object.keys(input)) if (!['account_no', 'proxy_id', 'home_cities'].includes(k)) return bad(`not a slot field: ${k}`);
  const { account_no, proxy_id, home_cities = [] } = input;
  if (!Number.isInteger(account_no) || (account_no as number) < 1) return bad('account_no');
  if (!Number.isInteger(proxy_id) || (proxy_id as number) < 1) return bad('proxy_id');
  if (!Array.isArray(home_cities) || home_cities.length > MAX_HOME_CITIES
      || !home_cities.every((h) => typeof h === 'string' && CITY_SLUG.test(h))) {
    return bad(`home_cities must list at most ${MAX_HOME_CITIES} city slugs`);
  }
  return { account_no: account_no as number, proxy_id: proxy_id as number, home_cities: [...new Set(home_cities as string[])] };
}

// Lock order: the pool account, then the proxy (which serialises two adds on
// one exit, so the limit holds), then the slot.
slots.post('/', async (c) => {
  const input = readSlotWrite(await c.req.json().catch(() => null));
  if (isRefusal(input)) return c.json(input.body, input.status);
  const { account_no: no, proxy_id: proxyId, home_cities: home } = input;
  const user = c.var.user;
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | { exit: string; device: string }> => {
    const [account] = await tx<{ status: string; holder_name: string | null; password_enc: string | null; totp_enc: string | null }[]>`
      SELECT status, holder_name, password_enc, totp_enc FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
    if (!account) return notFound(`account #${no}`);
    const [slot] = await tx`SELECT account_no FROM fleet_slots WHERE account_no = ${no}`;
    if (slot) return exists(`#${no} is in the fleet already`);
    // A fleet account with no slot is one a coordinator worker runs, unless
    // its holder is the ERP's own label: two browsers on one login is the
    // location churn that gets it checkpointed.
    const ours = account.status === 'fleet' && (account.holder_name === null || account.holder_name.toLowerCase() === FLEET_HOLDER.toLowerCase());
    if (account.status !== 'available' && !ours) {
      return conflict('account_busy', `#${no} is ${account.status}${account.holder_name ? ` (${account.holder_name})` : ''}; return it to the pool first`);
    }
    if (!account.password_enc || !account.totp_enc) return conflict('no_login', `#${no} needs a password and a 2FA key`);
    const [proxy] = await tx<{ url_enc: string; host: string; port: number; timezone: string }[]>`
      SELECT url_enc, host, port, timezone FROM fleet_proxies WHERE id = ${proxyId} FOR UPDATE`;
    if (!proxy) return notFound(`proxy ${proxyId}`);
    const limit = (await loadSettings(tx)).max_accounts_per_proxy;
    const [{ n }] = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM fleet_slots
      WHERE proxy_id = ${proxyId} AND lease_expires_at IS DISTINCT FROM 'infinity'::timestamptz`;
    if (n >= limit) return conflict('proxy_full', `${proxy.host}:${proxy.port} carries ${n} of ${limit} accounts`);
    if (home.length) {
      const known = new Set((await tx<{ slug: string }[]>`SELECT slug FROM fleet_cities WHERE slug = ANY(${home}::text[])`).map((r) => r.slug));
      const unknown = home.filter((h) => !known.has(h));
      if (unknown.length) return bad(`home_cities: unknown ${unknown.join(', ')}`);
    }
    const device = fleetDeviceFor(no, proxy.timezone);
    await tx`
      UPDATE fb_pool_accounts SET status = 'fleet', holder_user_id = NULL, holder_name = ${FLEET_HOLDER},
        held_since = CASE WHEN status = 'fleet' THEN held_since ELSE NOW() END, updated_at = NOW()
      WHERE no = ${no}`;
    await writeEvent(tx, user, 'assigned', 'fleet', no, FLEET_HOLDER);
    await tx`
      INSERT INTO fleet_slots (account_no, proxy_url, proxy_id, device, home_cities)
      VALUES (${no}, ${proxy.url_enc}, ${proxyId}, ${tx.json(device)}, ${tx.json(home)})`;
    return { exit: `${proxy.host}:${proxy.port}`, device: `${device.screen![0]}x${device.screen![1]}@${device.device_scale_factor}` };
  });
  if (isRefusal(out)) return c.json(out.body, out.status);
  wlog.info('fleet slot added', { accountNo: no, proxyId, exit: out.exit, device: out.device, homeCities: home.length, by: user.email });
  return c.json({ slot: await loadSlotView(sql, no) }, 201);
});

// Only a slot nobody holds: a leased one is parked first, which fences its
// worker out; deleting it under the worker would leave that browser running.
slots.post('/:no/remove', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | { status: string }> => {
    const [account] = await tx<{ status: string }[]>`SELECT status FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
    const [slot] = await tx<{ leased: boolean }[]>`
      SELECT COALESCE(lease_expires_at > NOW() AND lease_expires_at <> 'infinity'::timestamptz, FALSE) AS leased
      FROM fleet_slots WHERE account_no = ${no} FOR UPDATE`;
    if (!account || !slot) return notFound(`slot #${no}`);
    if (slot.leased) return conflict('leased', `#${no} is held by a worker; park it first`);
    await tx`DELETE FROM fleet_slots WHERE account_no = ${no}`;
    // A quarantine probe belongs to the account; nothing else would close it.
    await tx`UPDATE fleet_tasks SET state = 'cancelled', done_at = NOW() WHERE account_no = ${no} AND kind = 'probe' AND state = 'ready'`;
    // Only a fleet account goes back on the rack; one reported or retired
    // meanwhile keeps what the pool says about it.
    if (account.status === 'fleet') {
      await tx`
        UPDATE fb_pool_accounts SET status = 'available', holder_user_id = NULL, holder_name = NULL, held_since = NULL, updated_at = NOW()
        WHERE no = ${no}`;
      await writeEvent(tx, user, 'returned', 'available', no, `removed from the ${FLEET_HOLDER}`);
    }
    return { status: account.status === 'fleet' ? 'available' : account.status };
  });
  if (isRefusal(out)) return c.json(out.body, out.status);
  wlog.info('fleet slot removed', { accountNo: no, poolStatus: out.status, by: user.email });
  return c.json({ ok: true, account_no: no, pool_status: out.status });
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
        epoch = epoch + 1, worker_id = NULL, host_id = NULL, claim_id = NULL, handoff_epoch = NULL, reserved_until = NULL,
        lease_expires_at = 'infinity'::timestamptz
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
    UPDATE fleet_slots SET lease_expires_at = NULL, handoff_epoch = NULL, reserved_until = NULL
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

// ─── One worker, for its page ─────────────────────────────────────────────────
// Everything the worker page shows in one read, so it does not fan out over
// the slot, pool, proxy, task and event lists. Released tasks lose their
// worker_id, so what the worker did is read from its events, which keep it.

const DETAIL_DAYS = 7;
const DETAIL_EVENTS = 200;
const HISTORY_KINDS = ['done', 'stopped', 'released', 'expired'];

type AccountRow = {
  no: number; uid: string | null; email: string; status: string; holder_name: string | null; cookie_at: Date | null;
  password: boolean; totp: boolean; email_password: boolean; cookie: boolean; token: boolean;
};

workers.get('/:id', async (c) => {
  const id = c.req.param('id');
  if (!WORKER_ID.test(id)) return c.json({ error: 'not_found' }, 404);
  const sql = getDb(c.env);
  const byWorker = await workerViews(sql);
  const worker = byWorker.get(id);
  if (!worker) return c.json({ error: 'not_found', detail: id }, 404);
  const since = new Date(Date.now() - DETAIL_DAYS * 86_400_000);

  const [held] = await sql<SlotRow[]>`${SLOT_SELECT(sql)} WHERE s.worker_id = ${id}`;
  const [last] = held || worker.account_no === null ? [] : await sql<SlotRow[]>`${SLOT_SELECT(sql)} WHERE s.account_no = ${worker.account_no}`;
  const slotRow = held ?? last ?? null;
  const settings = await loadSettings(sql);
  const slot = slotRow ? slotView(slotRow, settings.budget_minutes, byWorker) : null;
  const no = slot?.account_no ?? worker.account_no;

  const [proxy] = slot?.proxy_id
    ? await sql<{ id: number; label: string; host: string; port: number; timezone: string }[]>`
        SELECT id, label, host, port, timezone FROM fleet_proxies WHERE id = ${slot.proxy_id}`
    : [];
  const [acct] = no === null ? [] : await sql<AccountRow[]>`
    SELECT no, uid, email, status, holder_name, cookie_at,
           password_enc IS NOT NULL AS password, totp_enc IS NOT NULL AS totp,
           email_password_enc IS NOT NULL AS email_password, cookie_enc IS NOT NULL AS cookie, token_enc IS NOT NULL AS token
    FROM fb_pool_accounts WHERE no = ${no}`;

  const [stats] = await sql<{ searches: number; alerts: number; last_search_at: Date | null }[]>`
    SELECT COUNT(*)::int AS searches,
           COALESCE(SUM(CASE WHEN result->>'alerted' ~ '^[0-9]+$' THEN (result->>'alerted')::int END), 0)::int AS alerts,
           MAX(done_at) AS last_search_at
    FROM fleet_tasks
    WHERE worker_id = ${id} AND state = 'done' AND kind = 'search' AND done_at >= ${since}`;
  const [{ errors }] = await sql<{ errors: number }[]>`
    SELECT COUNT(DISTINCT task_id)::int AS errors FROM fleet_task_events
    WHERE worker_id = ${id} AND at >= ${since}
      AND (kind = 'stopped' OR (kind = 'done' AND detail->>'stopped' = 'true'))`;

  const home = slot?.home_cities ?? [];
  const cityRows = await sql<{ slug: string; name: string | null; radius_km: number | null; last_done_at: Date | null; alerts: number }[]>`
    WITH mine AS (
      SELECT city, MAX(done_at) FILTER (WHERE state = 'done') AS last_done_at,
             COALESCE(SUM(CASE WHEN state = 'done' AND result->>'alerted' ~ '^[0-9]+$' THEN (result->>'alerted')::int END), 0)::int AS alerts
      FROM fleet_tasks
      WHERE worker_id = ${id} AND kind = 'search' AND GREATEST(leased_at, done_at) >= ${since}
      GROUP BY city
    ), wanted AS (
      SELECT unnest(${home}::text[]) AS city UNION SELECT city FROM mine
    )
    SELECT w.city AS slug, c.name, c.radius_km, m.last_done_at, COALESCE(m.alerts, 0)::int AS alerts
    FROM wanted w LEFT JOIN fleet_cities c ON c.slug = w.city LEFT JOIN mine m ON m.city = w.city`;
  const cities = cityRows
    .map((r) => ({ slug: r.slug, name: r.name, radius_km: r.radius_km, home: home.includes(r.slug), last_done_at: iso(r.last_done_at), alerts: r.alerts }))
    .sort((a, b) => Number(b.home) - Number(a.home)
      || (a.home ? home.indexOf(a.slug) - home.indexOf(b.slug) : (b.last_done_at ?? '').localeCompare(a.last_done_at ?? '')));

  const events = await sql<(TaskEventRow & { city: string; city_name: string | null; item: string; task_kind: FleetTask['kind'] })[]>`
    SELECT e.*, t.city, c.name AS city_name, t.item, t.kind AS task_kind
    FROM fleet_task_events e JOIN fleet_tasks t ON t.id = e.task_id LEFT JOIN fleet_cities c ON c.slug = t.city
    WHERE e.worker_id = ${id} AND e.at >= ${since} AND e.kind = ANY(${HISTORY_KINDS}::text[])
    ORDER BY e.at DESC, e.id DESC LIMIT ${DETAIL_EVENTS}`;
  const release = await loadRelease(sql);

  const secrets: FleetSecretKind[] = acct ? FLEET_SECRET_KINDS.filter((k) => acct[k]) : [];
  const body: FleetWorkerDetail = {
    worker,
    slot,
    holds_slot: !!held,
    proxy: proxy ?? null,
    account: acct ? {
      no: acct.no, uid: acct.uid, email: acct.email || null, status: acct.status, holder: acct.holder_name,
      cookie_at: iso(acct.cookie_at), secrets,
    } : null,
    cities,
    stats: { days: DETAIL_DAYS, searches: stats.searches, alerts: stats.alerts, errors, last_search_at: iso(stats.last_search_at) },
    log: await cityLog(sql, { worker: id, hours: 24 }),
    events: events.map((e) => ({ ...eventToWire(e), city: e.city, city_name: e.city_name, item: e.item, task_kind: e.task_kind })),
    release_version: release?.version ?? null,
  };
  return c.json(body);
});

export { slots, workers };
