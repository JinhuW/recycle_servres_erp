import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type postgres from 'postgres';
import {
  isFleetTimezone, fleetCloakFor, fleetCloakSwitchable, fleetDeviceFor, fleetReportedEngine, FLEET_PILOT_ARMS, type FleetCloakGpu, type FleetPilotArm, fleetStockRevertible, fleetResumable, fleetRestartable, FLEET_BROWSER_ENGINES, type FleetBrowserEngine, fleetSlotRetirable, FLEET_SECRET_KINDS, type FleetSecretKind, type FleetSlot, type FleetTask, type FleetWorker, type FleetWorkerDetail,
  type FleetWorkerRelogin, type FleetWorkerResume, type FbPoolStatus,
} from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { log } from '../lib/log';
import { retireAccount, writeEvent } from '../routes/facebookPool';
import { WORKER_ID } from '../routes/coordinator';
import { dropSlot, releaseTasks } from './claim';
import { loadRelease } from './hosts';
import { cityLog } from './tasks';
import { loadSettings } from './cities';
import { exitLoads, proxyStates } from './proxies';
import { exhaustedProxyIds } from './proxyMarks';
import { latestProxyExit } from './proxyExit';
import { managerOnly, type ManagerEnv } from './auth';
import { acceptLaunch, ENGINE_LOCK, freeFingerprint } from './profile';
import { bad, conflict, eventToWire, exists, isRefusal, minutesTodaySql, notFound, taskToWire, type Refusal, type TaskEventRow, type TaskRow } from './sql';

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
  lease_expires_at: Date | null; proxy_url: string | null; proxy_id: number | null; device: unknown;
  quarantined_until: Date | null; note: string; parked: boolean; reserved_until: Date | null;
  uid: string | null; pool_status: string; minutes_today: number; account_state: string | null; has_session: boolean; fleet_held: boolean;
  profile_first_launched_at: Date | null; profile_fingerprint: string | null; profile_build: string | null; profile_changed: boolean; profile_changed_build: string | null;
};

type WorkerRow = {
  worker_id: string; host_id: string | null; account_no: number | null; epoch: number | null; state: string | null;
  version: string | null; last_heartbeat_at: Date | null; vnc_port: number | null; detail: unknown;
  relogin_id: string | null; relogin_requested_at: Date | null; relogin_requested_by: string | null; relogin_delivered_at: Date | null;
  resume_id: string | null; resume_requested_at: Date | null; resume_requested_by: string | null; resume_delivered_at: Date | null;
  state_since: Date | null; auto_resumes: number;
};

function reloginOf(w: WorkerRow): FleetWorkerRelogin | null {
  if (!w.relogin_id || !w.relogin_requested_at) return null;
  return {
    id: w.relogin_id, requested_at: iso(w.relogin_requested_at)!, requested_by: w.relogin_requested_by,
    delivered_at: iso(w.relogin_delivered_at),
  };
}

function resumeOf(w: WorkerRow): FleetWorkerResume | null {
  if (!w.resume_id || !w.resume_requested_at) return null;
  return {
    id: w.resume_id, requested_at: iso(w.resume_requested_at)!, requested_by: w.resume_requested_by,
    delivered_at: iso(w.resume_delivered_at),
  };
}

type WorkerView = FleetWorker & { task: (FleetTask & { city_name: string | null }) | null };
type SlotView = FleetSlot & { uid: string | null; pool_status: string; minutes_today: number; budget_minutes: number; worker: WorkerView | null };

// The account's own last state, never another account's: a worker row is one
// container and is overwritten when it claims a different account, so only
// the row for this account's current lease counts (a NULL there is a boot in
// progress), and otherwise the account's latest recorded change.
const ACCOUNT_STATE = (sql: SqlLike) => sql`
  CASE WHEN EXISTS (SELECT 1 FROM fleet_workers w WHERE w.account_no = s.account_no AND w.epoch = s.epoch)
    THEN (SELECT w.state FROM fleet_workers w WHERE w.account_no = s.account_no AND w.epoch = s.epoch
          ORDER BY w.last_heartbeat_at DESC NULLS FIRST LIMIT 1)
    ELSE (SELECT e.to_state FROM fleet_worker_state_events e WHERE e.account_no = s.account_no
          ORDER BY e.at DESC, e.id DESC LIMIT 1)
  END`;

/** The pool holder a slot made here carries until a worker claims it. */
export const FLEET_HOLDER = 'ERP fleet';

// Whether a fleet worker has ever held the account, so any saved session of its
// could carry that worker's fingerprint.
const FLEET_HELD = (sql: SqlLike, no: ReturnType<SqlLike>) => sql`
  (EXISTS (SELECT 1 FROM fb_worker_accounts w WHERE w.account_no = ${no}
            AND lower(w.worker_id) <> lower(${FLEET_HOLDER}))
   OR EXISTS (SELECT 1 FROM fb_pool_events e WHERE e.account_no = ${no} AND e.kind = 'assigned'
                AND e.actor_id IS NULL AND e.actor_name LIKE 'fleet host %'))`;

const SLOT_SELECT = (sql: SqlLike) => sql`
  SELECT s.account_no, s.worker_id, s.host_id, s.last_host_id, s.epoch, s.lease_expires_at, s.proxy_url, s.proxy_id, s.device,
         s.quarantined_until, s.note,
         (s.lease_expires_at IS NOT DISTINCT FROM 'infinity'::timestamptz) AS parked,
         CASE WHEN s.reserved_until > NOW() THEN s.reserved_until END AS reserved_until,
         a.uid, a.status AS pool_status,
         a.profile_first_launched_at, a.profile_fingerprint, a.profile_launch->>'build' AS profile_build, a.profile_launch_changed->>'build' AS profile_changed_build,
         a.profile_launch_changed IS NOT NULL AS profile_changed,
         ${minutesTodaySql(sql, sql`s.account_no`)} AS minutes_today,
         ${ACCOUNT_STATE(sql)} AS account_state,
         COALESCE(a.cookie_enc, '') <> '' AS has_session,
         ${FLEET_HELD(sql, sql`s.account_no`)} AS fleet_held
  FROM fleet_slots s JOIN fb_pool_accounts a ON a.no = s.account_no`;

/** Every worker row with the task it holds, keyed by worker id. */
async function workerViews(sql: SqlLike): Promise<Map<string, WorkerView>> {
  const rows = await sql<WorkerRow[]>`SELECT * FROM fleet_workers ORDER BY worker_id`;
  const tasks = await sql<(TaskRow & { city_name: string | null })[]>`
    SELECT t.*, c.name AS city_name FROM fleet_tasks t LEFT JOIN fleet_cities c ON c.slug = t.city
    WHERE t.state = 'leased' AND t.worker_id IS NOT NULL`;
  const byWorker = new Map(tasks.map((t) => [t.worker_id!, { ...taskToWire(t), city_name: t.city_name }]));
  return new Map(rows.map((w) => [w.worker_id, {
    worker_id: w.worker_id,
    host_id: w.host_id,
    account_no: w.account_no,
    epoch: w.epoch,
    state: w.state,
    version: w.version,
    last_heartbeat_at: iso(w.last_heartbeat_at),
    vnc_port: w.vnc_port,
    detail: isRecord(w.detail) ? w.detail : null,
    state_since: iso(w.state_since),
    auto_resumes: w.auto_resumes,
    relogin: reloginOf(w),
    resume: resumeOf(w),
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
    profile: device?.browser_engine === 'cloak' ? {
      first_launched_at: iso(r.profile_first_launched_at),
      fingerprint: r.profile_fingerprint,
      build: r.profile_build,
      changed: r.profile_changed,
      changed_build: r.profile_changed_build,
    } : null,
    quarantined_until: iso(r.quarantined_until),
    note: r.note,
    parked: r.parked,
    reserved_until: iso(r.reserved_until),
    account_state: r.account_state,
    has_session: r.has_session,
    fleet_held: r.fleet_held,
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

type Enrollment = { pilot_id: string | null; arm: FleetPilotArm };
type SlotWrite = { account_no: number; proxy_id: number; enroll: Enrollment | null };

export const PILOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const PILOT_ID_RULE = 'pilot must be 1 to 64 letters, digits, dots, dashes or underscores';
const isArm = (v: unknown): v is FleetPilotArm => (FLEET_PILOT_ARMS as readonly unknown[]).includes(v);

function readSlotWrite(input: unknown): SlotWrite | Refusal {
  if (!isRecord(input)) return bad('expected an object');
  for (const k of Object.keys(input)) if (!['account_no', 'proxy_id', 'pilot', 'arm', 'engine'].includes(k)) return bad(`not a slot field: ${k}`);
  const { account_no, proxy_id, pilot, arm, engine } = input;
  if (!Number.isInteger(account_no) || (account_no as number) < 1) return bad('account_no');
  if (!Number.isInteger(proxy_id) || (proxy_id as number) < 1) return bad('proxy_id');
  if (pilot !== undefined && (typeof pilot !== 'string' || !PILOT_ID.test(pilot))) return bad(PILOT_ID_RULE);
  if (arm !== undefined && !isArm(arm)) return bad(`arm must be one of: ${FLEET_PILOT_ARMS.join(', ')}`);
  if (engine !== undefined && !isArm(engine)) return bad(`engine must be one of: ${FLEET_PILOT_ARMS.join(', ')}`);
  if ((pilot === undefined) !== (arm === undefined)) return bad('pilot and arm come together');
  // An account whose engine isn't its arm would be counted against the wrong browser.
  if (arm !== undefined && engine !== undefined && arm !== engine) return bad('engine must match arm');
  const chosen = (arm ?? engine) as FleetPilotArm | undefined;
  return {
    account_no: account_no as number,
    proxy_id: proxy_id as number,
    enroll: chosen ? { pilot_id: (pilot as string | undefined) ?? null, arm: chosen } : null,
  };
}

/** Why another account can't start on CloakBrowser now, or null. */
async function cloakSeatRefusal(tx: SqlLike): Promise<Refusal | null> {
  const settings = await loadSettings(tx);
  if (!settings.cloak_enabled) return conflict('cloak_disabled', 'CloakBrowser is off in the fleet settings');
  const [{ n }] = await tx<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM fleet_slots WHERE device->>'browser_engine' = 'cloak'`;
  return n >= settings.cloak_max_slots ? conflict('cloak_slots_full', `${n} of ${settings.cloak_max_slots} CloakBrowser slots are taken`) : null;
}

type Profile = { engine: FleetPilotArm; cloak_seed: number | null; cloak_gpu: FleetCloakGpu | null; timezone: string | null; device: unknown };

/** The parts of a device that stay with the account; engine, seed and clock have columns. */
function pinnedDevice(device: unknown): Record<string, unknown> | null {
  if (!isRecord(device)) return null;
  const picked = Object.entries(device).filter(([k]) => ['viewport', 'screen', 'device_scale_factor', 'locale', 'native'].includes(k));
  return picked.length ? Object.fromEntries(picked) : null;
}

async function writeProfile(tx: SqlLike, no: number, p: Profile): Promise<void> {
  const pinned = pinnedDevice(p.device);
  // COALESCE: the first pin is the device, and nothing after it rewrites it.
  await tx`UPDATE fb_pool_accounts SET browser_engine = ${p.engine}, cloak_seed = ${p.cloak_seed}, cloak_gpu = ${p.cloak_gpu},
    profile_timezone = ${p.timezone}, profile_device = COALESCE(profile_device, ${pinned === null ? null : tx.json(pinned as postgres.JSONValue)}) WHERE no = ${no}`;
}

/** Why another account can't go on a proxy now, or null. The limit is per exit
 *  IP, so the count covers every port that last exited where this one does. */
async function proxyFullRefusal(tx: SqlLike, proxyId: number, name: string, no: number): Promise<Refusal | null> {
  const limit = (await loadSettings(tx)).max_accounts_per_proxy;
  const load = (await exitLoads(tx, no, proxyId)).get(proxyId);
  if (!load || load.n < limit) return null;
  return conflict('proxy_full', load.ip === null
    ? `${name} carries ${load.n} of ${limit} accounts`
    : `${name} exits from ${load.ip}, which carries ${load.n} of ${limit} accounts`);
}

/** The exit an enrolled account goes out through, as freshly measured: its
 *  profile's clock and its enrollment record come from this reading. Sharing
 *  the IP is the limit's business, not this one's. */
async function measuredExit(tx: SqlLike, proxyId: number, name: string): Promise<Refusal | { ip: string; timezone: string | null }> {
  const check = await latestProxyExit(tx, proxyId);
  if (!check?.fresh) {
    return conflict('exit_stale', `${name} ${check ? 'was last measured too long ago' : 'has never been measured'}; check it again first`);
  }
  if (!check.ok || !check.exit_ip) return conflict('exit_failing', `${name} failed its latest check; pick another proxy or check it again`);
  return { ip: check.exit_ip, timezone: check.timezone };
}

/** A manager's way out of a held first login. After a first login the record
 *  stays, as the exit the account really started on is what a cohort has to see. */
const recordEnrolledExit = (tx: SqlLike, no: number, ip: string, zone: string | null) => tx`
  UPDATE fleet_pilot_enrollments SET exit_ip = ${ip}, exit_timezone = ${zone}
  WHERE account_no = ${no} AND first_login_at IS NULL`;

/** The clock a re-recorded exit brings. Only one the enrollment set itself moves:
 *  a profile pinned before the pilot has been shown to Facebook already. */
const repinnedZone = (enrolled: Pick<EnrollmentRow, 'first_login_at' | 'exit_timezone'>, pinned: string | null, zone: string | null): string | null =>
  enrolled.first_login_at === null && pinned === enrolled.exit_timezone && isFleetTimezone(zone) ? zone : null;

type PoolForSlot = {
  status: string; holder_name: string | null; password_enc: string | null; totp_enc: string | null; uid: string; batch: string;
  browser_engine: FleetPilotArm | null; cloak_seed: number | null; cloak_gpu: FleetCloakGpu | null; profile_timezone: string | null; profile_device: unknown;
  has_session: boolean; fleet_held: boolean; account_state: string | null;
};
type EnrollmentRow = {
  pilot_id: string | null; arm: FleetPilotArm; seed: number | null; first_claimed_at: Date | null;
  first_login_at: Date | null; exit_timezone: string | null;
};

// Lock order: the engine lock, the pool account, then the proxy, then the slot.
// Everything is written in this one transaction, with the slot last: a claim
// cannot see the slot until the rest of what it is handed is there too.
slots.post('/', async (c) => {
  const input = readSlotWrite(await c.req.json().catch(() => null));
  if (isRefusal(input)) return c.json(input.body, input.status);
  const { account_no: no, proxy_id: proxyId, enroll } = input;
  const user = c.var.user;
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | { exit: string; device: string; exitIp: string | null }> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${ENGINE_LOCK}))`;
    const [account] = await tx<PoolForSlot[]>`
      SELECT a.status, a.holder_name, a.password_enc, a.totp_enc, a.uid, a.batch,
             a.browser_engine, a.cloak_seed, a.cloak_gpu, a.profile_timezone, a.profile_device,
             COALESCE(a.cookie_enc, '') <> '' AS has_session,
             ${FLEET_HELD(tx, tx`a.no`)} AS fleet_held,
             (SELECT e.to_state FROM fleet_worker_state_events e WHERE e.account_no = a.no ORDER BY e.at DESC, e.id DESC LIMIT 1) AS account_state
      FROM fb_pool_accounts a WHERE a.no = ${no} FOR NO KEY UPDATE`;
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
    const exitName = `${proxy.host}:${proxy.port}`;
    const full = await proxyFullRefusal(tx, proxyId, exitName, no);
    if (full) return full;
    // A new account's first sign-in through a dead exit fails, and a failed
    // sign-in is what gets an account checkpointed. Never checked is allowed.
    if ((await proxyStates(tx, proxyId)).get(proxyId) === 'down') {
      return conflict('proxy_down', `${exitName} failed its last proxy checks; pick another proxy`);
    }
    if ((await exhaustedProxyIds(tx)).includes(proxyId)) {
      return conflict('proxy_exhausted', `${exitName} is exhausted; rotate its IP in Decodo or pick another proxy`);
    }

    let [enrolled] = await tx<EnrollmentRow[]>`SELECT pilot_id, arm, seed, first_claimed_at, first_login_at, exit_timezone FROM fleet_pilot_enrollments WHERE account_no = ${no}`;
    // A typo or the wrong arm can still be put right before a claim: no result
    // exists to protect yet, and nothing has shown this profile to Facebook.
    if (enroll && enrolled && enrolled.first_claimed_at === null && account.cloak_seed === enrolled.seed
        && (enrolled.pilot_id !== enroll.pilot_id || enrolled.arm !== enroll.arm)) {
      await tx`DELETE FROM fleet_pilot_enrollments WHERE account_no = ${no}`;
      await tx`UPDATE fb_pool_accounts SET browser_engine = NULL, cloak_seed = NULL, cloak_gpu = NULL, profile_timezone = NULL, profile_device = NULL WHERE no = ${no}`;
      Object.assign(account, { browser_engine: null, cloak_seed: null, cloak_gpu: null, profile_timezone: null, profile_device: null });
      enrolled = undefined as unknown as EnrollmentRow;
    }
    if (enroll && enrolled && (enrolled.pilot_id !== enroll.pilot_id || enrolled.arm !== enroll.arm)) {
      return conflict('already_enrolled', `#${no} is enrolled already (${enrolled.pilot_id ?? 'no pilot'}, ${enrolled.arm}); an account stays in the arm it was given`);
    }
    if (enroll) {
      // A seed is a fingerprint the account has shown, so it can only come back
      // on the engine it holds it under.
      const keepsCloak = enroll.arm === 'cloak' && account.browser_engine === 'cloak';
      if (account.cloak_seed !== null && !keepsCloak) return conflict('cloak_seeded', `#${no} has had a CloakBrowser seed already`);
      if (enroll.arm === 'cloak' && !keepsCloak && !fleetCloakSwitchable({
        epoch: 0, account_state: account.account_state, has_session: account.has_session, fleet_held: account.fleet_held, device: null,
      })) {
        return conflict('engine_live_session', `#${no} may still hold a live session (${account.account_state ?? 'no state yet'}); only an account that lost its session, or one no fleet worker has held, starts on CloakBrowser`);
      }
    }
    // A re-add brings back whatever engine the profile holds, so a removed
    // cloak account spends a seat and needs CloakBrowser on, like a new one.
    const engine: FleetPilotArm | null = enroll?.arm ?? account.browser_engine;
    if (engine === 'cloak') {
      const full = await cloakSeatRefusal(tx);
      if (full) return full;
    }
    const fingerprint = account.cloak_seed !== null
      ? { cloak_seed: account.cloak_seed, cloak_gpu: account.cloak_gpu! }
      : engine === 'cloak' ? await freeFingerprint(tx, no) : null;
    if (fingerprint && isRefusal(fingerprint)) return fingerprint;
    let exitIp: string | null = null;
    let exitZone: string | null = null;
    let measuredZone: string | null = null;
    let repinned: string | null = null;
    if (enroll || enrolled) {
      const measured = await measuredExit(tx, proxyId, exitName);
      if (isRefusal(measured)) return measured;
      exitIp = measured.ip;
      measuredZone = measured.timezone;
      if (enrolled) repinned = repinnedZone(enrolled, account.profile_timezone, measured.timezone);
      // A profile's clock comes from where it exits, since a typed zone goes stale.
      if (enroll && account.profile_timezone === null) {
        if (!isFleetTimezone(measured.timezone)) return conflict('exit_zone_unknown', `${exitName}'s latest measurement names no timezone; check it again first`);
        exitZone = measured.timezone;
      }
    }

    const timezone = repinned ?? account.profile_timezone ?? exitZone ?? proxy.timezone;
    const device = {
      ...fleetDeviceFor(no, timezone),
      // Worked out from a screen list that can change; the account's own stays.
      ...(pinnedDevice(account.profile_device) ?? {}),
      ...(engine ? { browser_engine: engine } : {}),
      ...(fingerprint ?? {}),
    };
    await tx`
      UPDATE fb_pool_accounts SET status = 'fleet', holder_user_id = NULL, holder_name = ${FLEET_HOLDER},
        held_since = CASE WHEN status = 'fleet' THEN held_since ELSE NOW() END, updated_at = NOW()
      WHERE no = ${no}`;
    await writeEvent(tx, user, 'assigned', 'fleet', no, FLEET_HOLDER);
    if (engine) {
      await writeProfile(tx, no, { engine, cloak_seed: fingerprint?.cloak_seed ?? null, cloak_gpu: fingerprint?.cloak_gpu ?? null, timezone, device: fleetDeviceFor(no, timezone) });
    }
    if (enroll && !enrolled) {
      await tx`
        INSERT INTO fleet_pilot_enrollments (account_no, uid, batch, pilot_id, arm, seed, exit_ip, exit_timezone, enrolled_by)
        VALUES (${no}, ${account.uid}, ${account.batch}, ${enroll.pilot_id}, ${enroll.arm}, ${enroll.arm === 'cloak' ? fingerprint!.cloak_seed : null}, ${exitIp!}, ${measuredZone}, ${user.email})`;
    } else if (enrolled) {
      await recordEnrolledExit(tx, no, exitIp!, measuredZone);
    }
    await tx`
      INSERT INTO fleet_slots (account_no, proxy_url, proxy_id, device)
      VALUES (${no}, ${proxy.url_enc}, ${proxyId}, ${tx.json(device)})`;
    return { exit: exitName, device: `${device.screen![0]}x${device.screen![1]}@${device.device_scale_factor}`, exitIp };
  });
  if (isRefusal(out)) return c.json(out.body, out.status);
  wlog.info('fleet slot added', {
    accountNo: no, proxyId, exit: out.exit, device: out.device, by: user.email,
    ...(enroll ? { pilot: enroll.pilot_id, arm: enroll.arm, exitIp: out.exitIp } : {}),
  });
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
    await dropSlot(tx, no, 'slot_removed');
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

// For an account that is lost (a checkpoint, an expired session): retiring
// the pool row fences the slot through the pool trigger, so its worker is
// refused on its next call and exits, and the container its host starts next
// claims another free slot. Unlike /remove, a held slot is fine here, but only
// one fleetSlotRetirable calls lost: the page's row may be a poll behind a
// Re-login that brought the worker back.
slots.post('/:no/retire', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | { worker_id: string | null }> => {
    const [account] = await tx<{ status: string }[]>`SELECT status FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
    const [slot] = await tx<{ worker_id: string | null; parked: boolean }[]>`
      SELECT worker_id, (lease_expires_at IS NOT DISTINCT FROM 'infinity'::timestamptz) AS parked
      FROM fleet_slots WHERE account_no = ${no} FOR UPDATE`;
    if (!account || !slot) return notFound(`slot #${no}`);
    // The last worker on the account says what became of it, even once the
    // slot has let it go.
    const [worker] = await tx<{ worker_id: string; state: string | null; detail: unknown }[]>`
      SELECT worker_id, state, detail FROM fleet_workers WHERE account_no = ${no}
      ORDER BY (worker_id = ${slot.worker_id}) DESC, last_heartbeat_at DESC NULLS LAST LIMIT 1`;
    const operator = isRecord(worker?.detail) && worker.detail.operator === true;
    if (!fleetSlotRetirable({ parked: slot.parked, poolStatus: account.status, state: worker?.state, operator })) {
      return conflict('not_lost', `#${no} is not parked; park it first`);
    }
    await retireAccount(tx, user, no, `retired from the ${FLEET_HOLDER}`);
    return { worker_id: slot.worker_id };
  });
  if (isRefusal(out)) return c.json(out.body, out.status);
  wlog.info('fleet slot retired', { accountNo: no, workerId: out.worker_id, by: user.email });
  return c.json({ ok: true, account_no: no, worker_id: out.worker_id });
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

// ─── Changing a slot's proxy ──────────────────────────────────────────────────
// Only the slot is written. A worker reads its proxy when it claims, so nothing
// restarts: a running one keeps its exit until its next normal start, and that
// start signs in from the new IP. That risk is why the call must say `confirm`
// and name the proxy the manager confirmed from. The limit and the down rule
// are Add to fleet's, with the same lock order.

slots.post('/:no/proxy', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'not_found' }, 404);
  const input = await c.req.json().catch(() => null);
  if (!isRecord(input)) return c.json(bad('expected an object').body, 422);
  for (const k of Object.keys(input)) {
    if (!['proxy_id', 'from_proxy_id', 'confirm'].includes(k)) return c.json(bad(`not a field: ${k}`).body, 422);
  }
  const { proxy_id: proxyId, from_proxy_id: fromId, confirm } = input;
  if (!Number.isInteger(proxyId) || (proxyId as number) < 1) return c.json(bad('proxy_id').body, 422);
  if (fromId !== null && (!Number.isInteger(fromId) || (fromId as number) < 1)) return c.json(bad('from_proxy_id must be the current proxy, or null').body, 422);
  if (confirm !== true) return c.json(bad('a proxy change has to be confirmed').body, 422);
  const toId = proxyId as number;
  const user = c.var.user;
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | { from: string; to: string; timezone: string }> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${ENGINE_LOCK}))`;
    const [account] = await tx<{ status: FbPoolStatus; pinned: boolean; profile_timezone: string | null }[]>`
      SELECT status, browser_engine IS NOT NULL AS pinned, profile_timezone FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
    const [proxy] = await tx<{ url_enc: string; host: string; port: number; timezone: string }[]>`
      SELECT url_enc, host, port, timezone FROM fleet_proxies WHERE id = ${toId} FOR UPDATE`;
    const [slot] = await tx<{ proxy_id: number | null; has_proxy: boolean }[]>`
      SELECT proxy_id, proxy_url IS NOT NULL AS has_proxy FROM fleet_slots WHERE account_no = ${no} FOR UPDATE`;
    if (!account || !slot) return notFound(`slot #${no}`);
    if (!proxy) return notFound(`proxy ${toId}`);
    const to = `${proxy.host}:${proxy.port}`;
    if (slot.proxy_id === toId) return exists(`#${no} is on ${to} already`);
    if (slot.proxy_id !== fromId) return conflict('proxy_changed', `#${no} moved to another proxy since this was opened; look again`);
    const full = await proxyFullRefusal(tx, toId, to, no);
    if (full) return full;
    if ((await proxyStates(tx, toId)).get(toId) === 'down') {
      return conflict('proxy_down', `${to} failed its last proxy checks; pick another proxy`);
    }
    if ((await exhaustedProxyIds(tx)).includes(toId)) {
      return conflict('proxy_exhausted', `${to} is exhausted; rotate its IP in Decodo or pick another proxy`);
    }
    const [enrolled] = await tx<EnrollmentRow[]>`SELECT pilot_id, arm, seed, first_claimed_at, first_login_at, exit_timezone FROM fleet_pilot_enrollments WHERE account_no = ${no}`;
    let repinned: string | null = null;
    if (enrolled) {
      const measured = await measuredExit(tx, toId, to);
      if (isRefusal(measured)) return measured;
      repinned = repinnedZone(enrolled, account.profile_timezone, measured.timezone);
      await recordEnrolledExit(tx, no, measured.ip, measured.timezone);
    }
    const [old] = slot.proxy_id === null ? [] : await tx<{ host: string; port: number }[]>`
      SELECT host, port FROM fleet_proxies WHERE id = ${slot.proxy_id}`;
    const from = old ? `${old.host}:${old.port}` : slot.has_proxy ? 'an unlisted proxy' : 'no proxy';
    await tx`
      UPDATE fleet_slots SET proxy_url = ${proxy.url_enc}, proxy_id = ${toId}
        ${account.pinned ? tx`` : tx`, device = CASE WHEN jsonb_typeof(device) = 'object' THEN jsonb_set(device, '{timezone}', to_jsonb(${proxy.timezone}::text)) ELSE device END`}
      WHERE account_no = ${no}`;
    if (repinned) {
      await tx`UPDATE fb_pool_accounts SET profile_timezone = ${repinned} WHERE no = ${no}`;
      await tx`UPDATE fleet_slots SET device = jsonb_set(device, '{timezone}', to_jsonb(${repinned}::text))
        WHERE account_no = ${no} AND jsonb_typeof(device) = 'object'`;
    }
    await writeEvent(tx, user, 'edited', account.status, no, `proxy ${from} -> ${to}`);
    return { from, to, timezone: repinned ?? (account.pinned ? 'pinned' : proxy.timezone) };
  });
  if (isRefusal(out)) return c.json(out.body, out.status);
  wlog.info('fleet slot proxy changed', { accountNo: no, proxyId: toId, from: out.from, exit: out.to, timezone: out.timezone, by: user.email });
  return c.json({ slot: await loadSlotView(sql, no) });
});

// ─── Browser engine ───────────────────────────────────────────────────────────
// A slot moves to CloakBrowser only while its account has no live session:
// the new fingerprint is a new machine, and a logged-in account that changes
// machine under Facebook's eyes is the checkpoint this exists to avoid. A park
// keeps the saved session, and the next claim hands it out again, so only a
// lost session or an account never logged in counts. The worker reads the
// engine at its next claim. Going back to stock is a second new machine, so it
// is only for a slot whose cloak session never got HEALTHY, and none may be
// starting on it. The seed and GPU stay on the device and the pool row either
// way: they are the fingerprint that account has shown, and it is not switched
// again, whichever slot it sits in later.

slots.post('/:no/engine', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'not_found' }, 404);
  const input = await c.req.json().catch(() => null);
  if (!isRecord(input) || !(FLEET_BROWSER_ENGINES as readonly unknown[]).includes(input.engine)) {
    return c.json(bad(`engine must be one of: ${FLEET_BROWSER_ENGINES.join(', ')}`).body, 422);
  }
  const engine = input.engine as FleetBrowserEngine;
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | { changed: boolean }> => {
    // Serialises switches, so two at once cannot both take the last cloak seat.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${ENGINE_LOCK}))`;
    // The profile below is written on the pool row, and a claim locks pool then
    // slot: taking the slot first here would deadlock against it.
    const [account] = await tx<{ cloak_seed: number | null }[]>`SELECT cloak_seed FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
    const [slot] = await tx<SlotRow[]>`${SLOT_SELECT(tx)} WHERE s.account_no = ${no} FOR UPDATE OF s`;
    if (!slot || !account) return notFound(`slot #${no}`);
    const device = isRecord(slot.device) ? slot.device as FleetSlot['device'] : null;
    const current = device?.browser_engine === 'cloak' ? 'cloak' : 'stock';
    if (engine === current) return { changed: false };
    const where = `${slot.worker_id ?? 'no worker'}, ${slot.account_state ?? (slot.epoch === 0 ? 'never claimed' : 'no state yet')}`;

    if (engine === 'stock') {
      const [proven] = await tx`
        SELECT 1 FROM fleet_worker_state_events
        WHERE account_no = ${no} AND engine = 'cloak' AND to_state = 'HEALTHY' LIMIT 1`;
      if (proven) return conflict('cloak_proven', `#${no} has been HEALTHY on CloakBrowser; going back would be another new machine`);
      if (!fleetStockRevertible(slot)) {
        return conflict('engine_live_session', `#${no} may be running on CloakBrowser (${where}); park it or wait for it to lose its session`);
      }
      await tx`UPDATE fleet_slots SET device = device || '{"browser_engine":"stock"}'::jsonb WHERE account_no = ${no}`;
      await tx`UPDATE fb_pool_accounts SET browser_engine = 'stock' WHERE no = ${no}`;
      return { changed: true };
    }

    if (device?.cloak_seed !== undefined || account.cloak_seed !== null) return conflict('cloak_seeded', `#${no} has had a CloakBrowser seed already`);
    const [arm] = await tx`SELECT 1 FROM fleet_pilot_enrollments WHERE account_no = ${no} AND arm = 'stock' AND pilot_id IS NOT NULL`;
    if (arm) return conflict('pilot_arm', `#${no} is in a pilot's stock arm; switching it would spoil the comparison`);
    if (!fleetCloakSwitchable({ ...slot, device })) {
      return conflict('engine_live_session', `#${no} may still hold a live session (${where}); only an account that lost its session, or one no fleet worker has held, switches`);
    }
    const full = await cloakSeatRefusal(tx);
    if (full) return full;
    const fingerprint = await freeFingerprint(tx, no);
    if (isRefusal(fingerprint)) return fingerprint;
    // Pinned for good from here, so it comes from where the slot really exits.
    const check = slot.proxy_id === null ? null : await latestProxyExit(tx, slot.proxy_id);
    const zone = check?.fresh && check.ok && isFleetTimezone(check.timezone) ? check.timezone : device?.timezone ?? null;
    const cloak = { browser_engine: 'cloak', ...fingerprint, ...(zone ? { timezone: zone } : {}) };
    await tx`UPDATE fleet_slots SET device = COALESCE(device, '{}'::jsonb) || ${tx.json(cloak)} WHERE account_no = ${no}`;
    await writeProfile(tx, no, { engine: 'cloak', ...fingerprint, timezone: zone, device });
    return { changed: true };
  });
  if (isRefusal(out)) return c.json(out.body, out.status);
  if (out.changed) wlog.info('fleet slot engine switched', { accountNo: no, engine, by: c.var.user.email });
  return c.json({ slot: await loadSlotView(sql, no) });
});

// A planned change, such as a new build: the fingerprint moved, and only a manager
// can say that's expected. The waiting worker runs its preflight again, in the same
// browser, and finds it matches.
slots.post('/:no/profile/accept', async (c) => {
  const no = parseNo(c.req.param('no'));
  if (no === null) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | true> => {
    if (!await acceptLaunch(tx, no, user.email)) return conflict('no_profile_change', `#${no} has no changed launch to accept`);
    await tx`
      UPDATE fleet_workers w SET resume_id = ${randomUUID()}, resume_requested_at = NOW(),
        resume_requested_by = ${user.email}, resume_delivered_at = NULL
      FROM fleet_slots s
      WHERE s.account_no = ${no} AND w.account_no = s.account_no AND w.epoch = s.epoch
        AND w.state = 'DEAD' AND w.detail->>'reason' = 'profile_changed'`;
    return true;
  });
  if (isRefusal(out)) return c.json(out.body, out.status);
  wlog.info('fleet profile change accepted', { accountNo: no, by: user.email });
  return c.json({ slot: await loadSlotView(sql, no) });
});

workers.get('/', async (c) => {
  const byWorker = await workerViews(getDb(c.env));
  return c.json({ workers: [...byWorker.values()] });
});

// ─── Re-login ─────────────────────────────────────────────────────────────────
// The fleet's twin of the coordinator's Re-login: the worker drops its session
// and signs in again with the pool account's password and 2FA key. Nothing is
// sent now; the request waits on the worker's row and its next heartbeat (every
// 20 s) carries `relogin` once (fleet/claim.ts). Only a worker that holds its
// slot can take it, so a stopped or fenced one is refused rather than handed
// a login at its next boot, which logs in anyway. Pressing it again while one
// waits answers the waiting one: two would still be one login.

/** A worker whose slot was switched since it started runs the old engine
 *  until its next claim; a session it mints now would be loaded into the new
 *  fingerprint at that claim, so neither a login nor a resume goes to it. */
async function engineMismatch(tx: SqlLike, w: WorkerRow): Promise<Refusal | null> {
  const [slot] = await tx<{ device: unknown }[]>`SELECT device FROM fleet_slots WHERE account_no = ${w.account_no}`;
  const device = slot && isRecord(slot.device) ? slot.device : null;
  const configured = device?.browser_engine === 'cloak' ? 'cloak' : 'stock';
  const running = fleetReportedEngine(isRecord(w.detail) ? w.detail : null);
  if (configured === running) return null;
  return conflict('engine_mismatch', `${w.worker_id} runs ${running} but #${w.account_no} is set to ${configured}, so it can't take this. It changes at its next normal start. A worker parked on a problem never reaches that start: Park then Unpark frees the account, but the worker may claim another account first, so this can take more than one login.`);
}

workers.post('/:id/relogin', async (c) => {
  const id = c.req.param('id');
  if (!WORKER_ID.test(id)) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | { relogin: FleetWorkerRelogin; fresh: boolean }> => {
    const [w] = await tx<WorkerRow[]>`SELECT * FROM fleet_workers WHERE worker_id = ${id} FOR UPDATE`;
    if (!w) return notFound(id);
    const [held] = await tx<{ account_no: number }[]>`
      SELECT account_no FROM fleet_slots
      WHERE worker_id = ${id} AND epoch = ${w.epoch} AND account_no = ${w.account_no}
        AND lease_expires_at > NOW() AND lease_expires_at <> 'infinity'::timestamptz`;
    if (!held) return conflict('not_running', `${id} holds no slot right now`);
    const mismatch = await engineMismatch(tx, w);
    if (mismatch) return mismatch;
    const pending = reloginOf(w);
    if (pending && pending.delivered_at === null) return { relogin: pending, fresh: false };
    const [row] = await tx<WorkerRow[]>`
      UPDATE fleet_workers SET relogin_id = ${randomUUID()}, relogin_requested_at = NOW(),
        relogin_requested_by = ${user.email}, relogin_delivered_at = NULL
      WHERE worker_id = ${id} RETURNING *`;
    return { relogin: reloginOf(row)!, fresh: true };
  });
  if (isRefusal(out)) return c.json(out.body, out.status);
  wlog.info('fleet relogin queued', { workerId: id, reloginId: out.relogin.id, fresh: out.fresh, by: user.email });
  return c.json({ ok: true, relogin: out.relogin });
});

// ─── Mark healthy ─────────────────────────────────────────────────────────────
// A worker that could not load a page parks with `connect_failed` and waits in
// its open browser; this tells it, on its next heartbeat, to try again there,
// with no new browser and no login. Only that park: the others leave the
// browser in a state nobody knows. Queued and delivered like a re-login. A worker
// parked on a moved exit takes the same directive as its manager's restart: it
// leaves for a new browser, which is one boot login, so the page asks first.

workers.post('/:id/resume', async (c) => {
  const id = c.req.param('id');
  if (!WORKER_ID.test(id)) return c.json({ error: 'not_found' }, 404);
  const user = c.var.user;
  const sql = getDb(c.env);
  const out = await sql.begin(async (tx): Promise<Refusal | { resume: FleetWorkerResume; fresh: boolean }> => {
    const [w] = await tx<WorkerRow[]>`SELECT * FROM fleet_workers WHERE worker_id = ${id} FOR UPDATE`;
    if (!w) return notFound(id);
    const [held] = await tx<{ account_no: number }[]>`
      SELECT account_no FROM fleet_slots
      WHERE worker_id = ${id} AND epoch = ${w.epoch} AND account_no = ${w.account_no}
        AND lease_expires_at > NOW() AND lease_expires_at <> 'infinity'::timestamptz`;
    if (!held) return conflict('not_running', `${id} holds no slot right now`);
    const mismatch = await engineMismatch(tx, w);
    if (mismatch) return mismatch;
    const pending = resumeOf(w);
    if (pending && pending.delivered_at === null) return { resume: pending, fresh: false };
    if (!fleetResumable(w.state, w.detail) && !fleetRestartable(w.state, w.detail)) {
      return conflict('not_parked', `${id} is not parked on a page that would not load`);
    }
    const [row] = await tx<WorkerRow[]>`
      UPDATE fleet_workers SET resume_id = ${randomUUID()}, resume_requested_at = NOW(),
        resume_requested_by = ${user.email}, resume_delivered_at = NULL
      WHERE worker_id = ${id} RETURNING *`;
    return { resume: resumeOf(row)!, fresh: true };
  });
  if (isRefusal(out)) return c.json(out.body, out.status);
  wlog.info('fleet resume queued', { workerId: id, resumeId: out.resume.id, fresh: out.fresh, by: user.email });
  return c.json({ ok: true, resume: out.resume });
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
  const exit = slot?.proxy_id ? await latestProxyExit(sql, slot.proxy_id) : null;
  const [stint] = held ? await sql<{ proxy_url: string | null }[]>`
    SELECT proxy_url FROM fb_worker_accounts WHERE account_no = ${held.account_no} AND ended_at IS NULL` : [];
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

  const cityRows = await sql<{ slug: string; name: string | null; radius_km: number | null; last_done_at: Date | null; alerts: number }[]>`
    WITH mine AS (
      SELECT city, MAX(done_at) FILTER (WHERE state = 'done') AS last_done_at,
             COALESCE(SUM(CASE WHEN state = 'done' AND result->>'alerted' ~ '^[0-9]+$' THEN (result->>'alerted')::int END), 0)::int AS alerts
      FROM fleet_tasks
      WHERE worker_id = ${id} AND kind = 'search' AND GREATEST(leased_at, done_at) >= ${since}
      GROUP BY city
    )
    SELECT m.city AS slug, c.name, c.radius_km, m.last_done_at, m.alerts
    FROM mine m LEFT JOIN fleet_cities c ON c.slug = m.city
    ORDER BY m.last_done_at DESC NULLS LAST, m.city`;
  const cities = cityRows.map((r) => ({ slug: r.slug, name: r.name, radius_km: r.radius_km, last_done_at: iso(r.last_done_at), alerts: r.alerts }));

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
    proxy_down: !!exit?.fresh && !exit.ok,
    running_exit: stint?.proxy_url ?? null,
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
