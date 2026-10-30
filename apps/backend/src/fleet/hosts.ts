import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { JSONValue } from 'postgres';
import { fleetStateParked, type ClaimTicketAnswer, type DesiredAnswer, type FleetHost, type FleetHostContainer, type FleetHostReport, type FleetRelease } from '@recycle-erp/shared';
import { getDb, type SqlLike } from '../db';
import { log } from '../lib/log';
import type { Env } from '../types';
import { CLAIM_TICKET_MINUTES, hostAuth, managerOnly, newClaimTicket, type HostEnv, type ManagerEnv } from './auth';
import { sha256hex, type FleetHostRow, type FleetSlotRow } from './sql';
import { releaseTasks } from './claim';

// ─── Hosts and releases ───────────────────────────────────────────────────────
// A host is a machine running one fleet-agent container. The ERP tells it what
// to run (`desired`: how many workers, on which image) and it tells the ERP
// what runs (`report`). A release names a new worker image; the ERP then
// replaces one idle worker at a time, fleet-wide, and waits for each to come
// back on the new version before naming the next. The rules are the Python
// coordinator's `advance_rollout`: the next step waits for a heartbeat on the
// new version in a state no worse than before, a worker that does not come
// back in time stops the release, and workers on observe-only or silent hosts
// are left out rather than waited for.

type Vars = ManagerEnv['Variables'] & HostEnv['Variables'];
const hosts = new Hono<{ Bindings: Env; Variables: Vars }>();

const HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const IMAGE_REF = /^[a-z0-9][a-z0-9._\/-]*(:[A-Za-z0-9._-]{1,128})?(@sha256:[0-9a-f]{64})?$/;
export const FIRST_VNC_PORT = 5901;
// An agent reports every 30 s; a host silent this long is not rolled.
export const HOST_LIVE_MS = 2 * 60_000;
// How long a replaced worker has to come back on the new version.
export const GATE_TIMEOUT_MS = 20 * 60_000;
// A heartbeat this recent means the worker was up when its replacement began.
const FRESH_HEARTBEAT_MS = 15 * 60_000;
const MAX_REPORT_BYTES = 200_000;
const RELEASE_KEY = 'release';

const hlog = log.child({ module: 'fleet' });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

function reportOf(raw: unknown): FleetHostReport | null {
  if (!isRecord(raw) || typeof raw.version !== 'string' || !Array.isArray(raw.containers)) return null;
  return raw as FleetHostReport;
}

function hostView(r: FleetHostRow): FleetHost {
  return {
    host_id: r.host_id,
    capacity: r.capacity,
    authoritative: r.authoritative,
    version: r.version,
    last_seen_at: iso(r.last_seen_at),
    report: reportOf(r.report),
    created_at: r.created_at.toISOString(),
  };
}

// ─── Releases ─────────────────────────────────────────────────────────────────

export async function loadRelease(sql: SqlLike, lock = false): Promise<FleetRelease | null> {
  const rows = await sql<{ value: unknown }[]>`
    SELECT value FROM fleet_settings WHERE key = ${RELEASE_KEY} ${lock ? sql`FOR UPDATE` : sql``}`;
  const v = rows[0]?.value;
  return isRecord(v) && typeof v.image === 'string' && typeof v.version === 'string' ? (v as FleetRelease) : null;
}

async function saveRelease(sql: SqlLike, release: FleetRelease): Promise<void> {
  await sql`
    INSERT INTO fleet_settings (key, value, updated_at) VALUES (${RELEASE_KEY}, ${sql.json(release)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;
}

/** The image new workers start on: the latest release unless it failed, else the environment's. */
function fleetImage(env: Env, release: FleetRelease | null): { image: string; version: string } {
  if (release && release.state !== 'failed') return { image: release.image, version: release.version };
  const image = env.FLEET_IMAGE_WORKER ?? '';
  const tag = /:([^:/@]+)(@|$)/.exec(image)?.[1] ?? '';
  return { image, version: tag };
}

/** Whether a replaced worker came back no worse than it left (the coordinator's gate_ok). */
export function gateOk(preState: string | null, postState: string | null): boolean {
  if (preState === 'HEALTHY') return postState === 'HEALTHY';
  if (preState === null || preState === 'DOWN') return true;
  return postState !== 'DEAD';
}

type WorkerRow = { worker_id: string; state: string | null; version: string | null; last_heartbeat_at: Date | null; epoch: number | null; account_no: number | null };

function onVersion(w: WorkerRow | undefined, version: string, since: Date): boolean {
  if (!w || !w.last_heartbeat_at) return false;
  const reported = w.version ?? '';
  return (reported === version || reported.startsWith(version + ' ')) && w.last_heartbeat_at.getTime() >= since.getTime();
}

const live = (h: FleetHostRow, now: number) => h.last_seen_at !== null && now - h.last_seen_at.getTime() < HOST_LIVE_MS;

/** Whether `id` is one the host's agent names its own workers by (`{host}-{n}`). */
export function ownWorkerId(hostId: string, id: string): boolean {
  return id.startsWith(`${hostId}-`) && /^[1-9][0-9]*$/.test(id.slice(hostId.length + 1));
}

type Pending = { worker_id: string; state: string; hold: string | null };

/** Containers on a host's last report that are not yet on the release's image, nor already dealt with. */
function pendingContainers(h: FleetHostRow, release: FleetRelease): Pending[] {
  const report = reportOf(h.report);
  if (!report) return [];
  return report.containers
    .filter((c) => isRecord(c) && typeof c.worker_id === 'string' && ownWorkerId(h.host_id, c.worker_id) && c.image !== release.image)
    .map((c) => ({ worker_id: c.worker_id, state: typeof c.state === 'string' ? c.state : '', hold: typeof c.hold === 'string' && c.hold ? c.hold : null }))
    .filter((c) => !release.upgraded.includes(c.worker_id) && !release.skipped.includes(c.worker_id))
    .sort((a, b) => a.worker_id.localeCompare(b.worker_id));
}

const pending = (h: FleetHostRow, release: FleetRelease): string[] => pendingContainers(h, release).map((c) => c.worker_id);

/**
 * Why a pending worker cannot be replaced, or null when it can. The agent
 * only replaces a running container, so a stopped one would be named and
 * never acted on until the gate failed the release; and a worker parked on
 * its account (checkpoint, expired session, challenge, dead proxy) would be
 * rebooted into a fresh login that cannot pass the gate either.
 */
function unreplaceable(c: Pending, w: WorkerRow | undefined): string | null {
  if (c.hold) return `held: ${c.hold}`;
  if (c.state !== 'running') return `container ${c.state || 'not running'}`;
  if (fleetStateParked(w?.state)) return `worker ${w!.state}`;
  return null;
}

function skip(release: FleetRelease, worker_id: string, reason: string): void {
  release.skipped = [...release.skipped, worker_id];
  release.skip_reasons = { ...(release.skip_reasons ?? {}), [worker_id]: reason };
}

/**
 * Moves the active release one step for the host asking, and says which of
 * its workers to replace now, if any. One worker at a time across the fleet:
 * while a replacement is pending nobody else is told to replace anything.
 */
async function advanceRoll(tx: SqlLike, host: FleetHostRow, now = new Date()): Promise<string | null> {
  const release = await loadRelease(tx, true);
  if (!release || release.state !== 'rolling') return null;
  const allHosts = await tx<FleetHostRow[]>`SELECT * FROM fleet_hosts`;
  const workers = new Map(
    (await tx<WorkerRow[]>`SELECT worker_id, state, version, last_heartbeat_at, epoch, account_no FROM fleet_workers`).map((w) => [w.worker_id, w]),
  );

  if (release.current) {
    const cur = release.current;
    const w = workers.get(cur.worker_id);
    const started = new Date(cur.started_at);
    // A slot's epoch only orders claims on that one account: the replacement
    // may come back on another (its old account was retired meanwhile).
    const reclaimed = cur.epoch === undefined || (cur.account_no !== undefined && w?.account_no !== cur.account_no) || (w?.epoch ?? 0) > cur.epoch;
    if (onVersion(w, release.version, started) && reclaimed && gateOk(cur.pre_state, w?.state ?? null)) {
      release.upgraded = [...release.upgraded, cur.worker_id];
      release.current = null;
    } else if (now.getTime() - new Date(cur.stopped_at ?? cur.started_at).getTime() > (cur.stopped_at ? GATE_TIMEOUT_MS : 2 * GATE_TIMEOUT_MS)) {
      release.state = 'failed';
      release.failure = `${cur.worker_id} did not come back on ${release.version} in a state no worse than `
        + `${cur.pre_state} within ${GATE_TIMEOUT_MS / 60_000} minutes `
        + `(it reports ${w?.version ?? 'nothing'}, ${w?.state ?? 'no state'})`;
      release.current = null;
      release.finished_at = now.toISOString();
      await saveRelease(tx, release);
      hlog.warn('fleet release stopped', { version: release.version, failure: release.failure });
      return null;
    } else {
      return cur.host_id === host.host_id ? cur.worker_id : null;
    }
  }

  // Workers on observe-only or long-silent hosts are skipped, not waited for;
  // the host asking is live by definition. A host only briefly silent (an ERP
  // deploy, a network blip) is waited for, or the roll would finish without
  // it. A busy worker (a leased task) waits.
  for (const h of allHosts) {
    if (h.host_id === host.host_id && !host.authoritative) {
      for (const id of pending(h, release)) skip(release, id, 'host is observe-only');
    } else if (h.host_id !== host.host_id && !h.authoritative) {
      for (const id of pending(h, release)) skip(release, id, 'host is observe-only');
    } else if (h.host_id !== host.host_id && !live(h, now.getTime())) {
      if (!h.last_seen_at || now.getTime() - h.last_seen_at.getTime() > GATE_TIMEOUT_MS) {
        for (const id of pending(h, release)) skip(release, id, 'host is silent');
      }
    } else {
      for (const c of pendingContainers(h, release)) {
        const why = unreplaceable(c, workers.get(c.worker_id));
        if (why) skip(release, c.worker_id, why);
      }
    }
  }
  let replace: string | null = null;
  if (host.authoritative) {
    const candidates = pending(host, release);
    if (candidates.length) {
      await tx`SELECT account_no FROM fleet_slots WHERE worker_id = ANY(${candidates}::text[]) ORDER BY account_no FOR UPDATE`;
      const busy = new Set((await tx<{ worker_id: string }[]>`
        SELECT DISTINCT worker_id FROM fleet_tasks
        WHERE state = 'leased' AND worker_id = ANY(${candidates}::text[])`).map((r) => r.worker_id));
      const idle = candidates.find((id) => !busy.has(id));
      if (idle) {
        const w = workers.get(idle);
        const fresh = w?.last_heartbeat_at && now.getTime() - w.last_heartbeat_at.getTime() < FRESH_HEARTBEAT_MS;
        release.current = { worker_id: idle, host_id: host.host_id, started_at: now.toISOString(), pre_state: fresh ? (w?.state ?? 'DOWN') : 'DOWN', ...(w?.epoch !== null && w?.epoch !== undefined ? { epoch: w.epoch } : {}), ...(w?.account_no != null ? { account_no: w.account_no } : {}) };
        replace = idle;
      }
    }
  }

  if (!release.current && allHosts.every((h) => pending(h, release).length === 0)) {
    release.state = 'done';
    release.finished_at = now.toISOString();
    hlog.info('fleet release done', { version: release.version, upgraded: release.upgraded.length, skipped: release.skipped });
  }
  await saveRelease(tx, release);
  return replace;
}

/**
 * How many workers the host should run: its capacity, but no more than it has
 * accounts for. Every worker start is a Facebook login, and a worker with no
 * slot to claim only exits and is restarted, so the count follows the slots:
 * the ones this host's workers hold (a lease or a handoff reservation of this
 * host's), plus the ones any worker could claim now (a fleet account, not
 * parked, lease free). Never below the highest-numbered worker holding a slot:
 * the agent leaves a worker above `count` alone, so one that exits is not
 * restarted and its account waits for a fresh login elsewhere.
 */
async function workerCount(tx: SqlLike, host: FleetHostRow): Promise<number> {
  if (!host.authoritative || host.capacity <= 0) return 0;
  const rows = await tx<{ held: string | null; free: boolean }[]>`
    SELECT CASE WHEN s.host_id = ${host.host_id} AND s.lease_expires_at > NOW() THEN COALESCE(s.worker_id, '') END AS held,
           (s.lease_expires_at IS NULL OR s.lease_expires_at < NOW()) AS free
    FROM fleet_slots s JOIN fb_pool_accounts a ON a.no = s.account_no
    WHERE a.status = 'fleet' AND s.lease_expires_at IS DISTINCT FROM 'infinity'::timestamptz`;
  const held = rows.filter((r) => r.held !== null);
  const usable = held.length + rows.filter((r) => r.free).length;
  const highest = Math.max(0, ...held.map((r) => (r.held && ownWorkerId(host.host_id, r.held) ? Number(r.held.slice(host.host_id.length + 1)) : 0)));
  return Math.min(host.capacity, Math.max(usable, highest));
}

/** What the host's agent should run; `roll` only when `advance` is set (the agent asking), never for a manager's read. */
async function desired(tx: SqlLike, env: Env, host: FleetHostRow, advance: boolean): Promise<DesiredAnswer> {
  const replace = advance ? await advanceRoll(tx, host) : (await loadRelease(tx))?.current;
  const release = await loadRelease(tx);
  const { image, version } = fleetImage(env, release);
  const count = await workerCount(tx, host);
  const vnc_ports: Record<string, number> = {};
  for (let n = 1; n <= count; n++) vnc_ports[`${host.host_id}-${n}`] = FIRST_VNC_PORT + n - 1;
  const roll = typeof replace === 'string'
    ? { replace }
    : replace && replace.host_id === host.host_id ? { replace: replace.worker_id } : null;
  const slots = await tx<{ worker_id: string; account_no: number; epoch: number }[]>`
    SELECT worker_id, account_no, epoch FROM fleet_slots WHERE host_id = ${host.host_id} AND worker_id IS NOT NULL`;
  const leases = Object.fromEntries(slots.map(s => [s.worker_id, { account_no: s.account_no, epoch: s.epoch }]));
  return { authoritative: host.authoritative, count, image, version, vnc_ports, roll, leases };
}

// ─── Manager routes ───────────────────────────────────────────────────────────

hosts.get('/', managerOnly, async (c) => {
  const sql = getDb(c.env);
  const rows = await sql<FleetHostRow[]>`SELECT * FROM fleet_hosts ORDER BY host_id`;
  const release = await loadRelease(sql);
  const out = [];
  for (const r of rows) {
    const d = await desired(sql, c.env, r, false);
    out.push({ ...hostView(r), desired: { count: d.count, image: d.image, version: d.version, roll: d.roll } });
  }
  return c.json({ hosts: out, release });
});

hosts.post('/', managerOnly, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { host_id?: unknown } | null;
  const id = body?.host_id;
  if (typeof id !== 'string' || !HOST_ID.test(id)) {
    return c.json({ error: 'bad_request', detail: 'host_id: lowercase letters, digits and dashes' }, 422);
  }
  // The token is shown once; only its hash is kept, so the ERP cannot hand it out again.
  const token = randomBytes(32).toString('hex');
  const sql = getDb(c.env);
  const rows = await sql<FleetHostRow[]>`
    INSERT INTO fleet_hosts (host_id, token_hash) VALUES (${id}, ${sha256hex(token)})
    ON CONFLICT (host_id) DO NOTHING
    RETURNING *`;
  if (!rows.length) return c.json({ error: 'exists' }, 409);
  hlog.info('fleet host registered', { hostId: id, by: c.var.user.email });
  const d = await desired(sql, c.env, rows[0], false);
  return c.json({ host: { ...hostView(rows[0]), desired: { count: d.count, image: d.image, version: d.version, roll: d.roll }, token } });
});

hosts.put('/:id', managerOnly, async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { capacity?: unknown; authoritative?: unknown } | null;
  if (!body) return c.json({ error: 'bad_request' }, 422);
  const capacity = body.capacity;
  if (capacity !== undefined && !(Number.isInteger(capacity) && (capacity as number) >= 0 && (capacity as number) <= 99)) {
    return c.json({ error: 'bad_request', detail: 'capacity' }, 422);
  }
  if (body.authoritative !== undefined && typeof body.authoritative !== 'boolean') {
    return c.json({ error: 'bad_request', detail: 'authoritative' }, 422);
  }
  const sql = getDb(c.env);
  const rows = await sql<FleetHostRow[]>`
    UPDATE fleet_hosts SET
      capacity = COALESCE(${capacity === undefined ? null : (capacity as number)}, capacity),
      authoritative = COALESCE(${body.authoritative === undefined ? null : (body.authoritative as boolean)}, authoritative)
    WHERE host_id = ${id}
    RETURNING *`;
  if (!rows.length) return c.json({ error: 'not_found' }, 404);
  hlog.info('fleet host updated', { hostId: id, capacity: rows[0].capacity, authoritative: rows[0].authoritative, by: c.var.user.email });
  const d = await desired(sql, c.env, rows[0], false);
  return c.json({ host: { ...hostView(rows[0]), desired: { count: d.count, image: d.image, version: d.version, roll: d.roll } } });
});

hosts.delete('/:id', managerOnly, async (c) => {
  const id = c.req.param('id');
  // The release row, then the pool accounts, then the slots: the order every
  // worker write takes. A replacement the host reserved would otherwise hold
  // its account until the reservation lapsed, with no agent left to use it.
  const out = await getDb(c.env).begin(async (tx) => {
    const release = await loadRelease(tx, true);
    await tx`SELECT no FROM fb_pool_accounts WHERE no IN (SELECT account_no FROM fleet_slots WHERE host_id = ${id}) ORDER BY no FOR NO KEY UPDATE`;
    await tx`SELECT account_no FROM fleet_slots WHERE host_id = ${id} ORDER BY account_no FOR UPDATE`;
    const freed = await tx<{ account_no: number }[]>`
      UPDATE fleet_slots SET epoch = epoch + 1, worker_id = NULL, lease_expires_at = NULL, reserved_until = NULL,
        claim_id = NULL, handoff_epoch = NULL
      WHERE host_id = ${id} AND reserved_until IS NOT NULL
      RETURNING account_no`;
    const rows = await tx<{ host_id: string }[]>`DELETE FROM fleet_hosts WHERE host_id = ${id} RETURNING host_id`;
    if (!rows.length) return null;
    if (release?.state === 'rolling' && release.current?.host_id === id) {
      skip(release, release.current.worker_id, 'host removed');
      release.current = null;
      await saveRelease(tx, release);
    }
    return { freed: freed.map((f) => f.account_no) };
  });
  if (!out) return c.json({ error: 'not_found' }, 404);
  hlog.info('fleet host removed', { hostId: id, by: c.var.user.email, reservationsFreed: out.freed });
  return c.json({ ok: true });
});

/** `POST /api/fleet/releases`, mounted by routes/fleet.ts: starts a roll onto `image`; an active one is superseded. */
export const releases = new Hono<ManagerEnv>().post('/', managerOnly, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { image?: unknown; version?: unknown } | null;
  const image = body?.image;
  const version = body?.version;
  if (typeof image !== 'string' || !IMAGE_REF.test(image)) return c.json({ error: 'bad_request', detail: 'image' }, 422);
  if (typeof version !== 'string' || !version || version.length > 64) return c.json({ error: 'bad_request', detail: 'version' }, 422);
  const sql = getDb(c.env);
  const release = await sql.begin(async (tx) => {
    const active = await loadRelease(tx, true);
    if (active && active.state === 'rolling') {
      hlog.info('fleet release superseded', { version: active.version, by: version });
    }
    const next: FleetRelease = {
      image, version, state: 'rolling', started_at: new Date().toISOString(), finished_at: null,
      upgraded: [], skipped: [], current: null, failure: null,
    };
    await saveRelease(tx, next);
    return next;
  });
  hlog.info('fleet release started', { version, image, by: c.var.user.email });
  return c.json({ ok: true, release });
});

// ─── Host-agent routes ────────────────────────────────────────────────────────

// ─── One agent per host ───────────────────────────────────────────────────────
// Two agents for one host (a second container started by hand, a host cloned
// with its token) would each start and replace the same workers, and every
// start is a Facebook login. The agent names its process in
// X-Fleet-Agent-Instance; the first instance seen holds the host until it has
// been silent for HOST_LIVE_MS, and any other is refused 403, which the agent
// reads as "observe only". An agent too old to send an instance is let
// through as it always was.

const AGENT_INSTANCE = /^[A-Za-z0-9._:-]{1,128}$/;
export const AGENT_CONFLICT = 'agent_conflict';

type AgentIdentity = { instance_id: string; daemon_id: string | null };

function agentOf(header: string | undefined, daemon: string | undefined, body?: unknown): AgentIdentity | null {
  const fromBody = isRecord(body) && isRecord(body.agent) ? body.agent : null;
  const instance = header ?? (typeof fromBody?.instance_id === 'string' ? fromBody.instance_id : undefined);
  if (!instance || !AGENT_INSTANCE.test(instance)) return null;
  const d = daemon ?? (typeof fromBody?.daemon_id === 'string' ? fromBody.daemon_id : undefined);
  return { instance_id: instance, daemon_id: d ? d.slice(0, 128) : null };
}

/** Records the asking agent as the host's, or answers false when another live instance holds it. */
async function holdHost(sql: SqlLike, hostId: string, agent: AgentIdentity | null): Promise<boolean> {
  if (!agent) return true;
  const rows = await sql`
    UPDATE fleet_hosts SET agent_instance = ${agent.instance_id}, agent_daemon = ${agent.daemon_id}, agent_seen_at = NOW()
    WHERE host_id = ${hostId}
      AND (agent_instance IS NULL OR agent_instance = ${agent.instance_id}
           OR agent_seen_at IS NULL OR agent_seen_at < NOW() - make_interval(secs => ${HOST_LIVE_MS / 1000}))
    RETURNING host_id`;
  return rows.length > 0;
}

const agentConflict = (hostId: string) => ({
  error: AGENT_CONFLICT,
  detail: `another fleet agent instance is running for ${hostId}; this one may only observe`,
});

hosts.get('/:id/desired', hostAuth, async (c) => {
  const host: FleetHostRow = c.var.host;
  const sql = getDb(c.env);
  const agent = agentOf(c.req.header('X-Fleet-Agent-Instance'), c.req.header('X-Fleet-Docker-Daemon'));
  const answer = await sql.begin(async (tx) => {
    if (!await holdHost(tx, host.host_id, agent)) return null;
    return desired(tx, c.env, host, true);
  });
  if (!answer) {
    hlog.warn('fleet desired refused: second agent', { hostId: host.host_id, instance: agent?.instance_id });
    return c.json(agentConflict(host.host_id), 403);
  }
  return c.json(answer);
});

hosts.post('/:id/stopped', hostAuth, async (c) => {
  const host: FleetHostRow = c.var.host;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.worker_id !== 'string' || !Number.isInteger(body.account_no)
      || !Number.isInteger(body.epoch) || typeof body.restart !== 'boolean') return c.json({ error: 'bad_request' }, 422);
  const no = body.account_no as number;
  const epoch = body.epoch as number;
  const ok = await getDb(c.env).begin(async tx => {
    const r = await loadRelease(tx, true);
    await tx`SELECT no FROM fb_pool_accounts WHERE no = ${no} FOR NO KEY UPDATE`;
    const [s] = await tx<FleetSlotRow[]>`SELECT * FROM fleet_slots WHERE account_no = ${no} FOR UPDATE`;
    if (!s) return false;
    if (s.handoff_epoch === epoch && s.worker_id === body.worker_id && s.host_id === host.host_id) {
      if (!body.restart) await tx`UPDATE fleet_slots SET lease_expires_at = NULL, reserved_until = NULL WHERE account_no = ${no} AND reserved_until IS NOT NULL`;
      return true;
    }
    if (s.epoch !== epoch || s.worker_id !== body.worker_id || s.host_id !== host.host_id) return false;
    await releaseTasks(tx, { account_no: no }, 'host_stopped');
    // The reservation lapses when the roll gate would fail (GATE_TIMEOUT_MS
    // from stopped_at): a replacement that never claims frees the account
    // then, for any worker, instead of holding it until a person notices.
    const until = body.restart ? tx`NOW() + ${`${GATE_TIMEOUT_MS / 1000} seconds`}::interval` : tx`NULL`;
    await tx`UPDATE fleet_slots SET epoch = epoch + 1, claim_id = NULL, handoff_epoch = ${epoch},
      reserved_until = ${until}, lease_expires_at = ${until}
      WHERE account_no = ${no}`;
    if (r?.state === 'rolling' && r.current && r.current.worker_id === body.worker_id && r.current.host_id === host.host_id) {
      r.current.stopped_at = new Date().toISOString();
      await saveRelease(tx, r);
    }
    return true;
  });
  return ok ? c.json({ ok: true }) : c.json({ error: 'stale_epoch' }, 409);
});

// The agent asks for one right before each `docker run` and hands the worker
// that instead of its own token (fleet/auth.ts, Claim tickets). A newer ticket
// for the same worker voids the older ones: the container they were for is
// gone, since the agent runs a worker only where none exists.
hosts.post('/:id/tickets', hostAuth, async (c) => {
  const host: FleetHostRow = c.var.host;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.worker_id !== 'string' || body.worker_id.length > 80 || !ownWorkerId(host.host_id, body.worker_id)) {
    return c.json({ error: 'bad_request', detail: 'worker_id must be <host_id>-<n>' }, 422);
  }
  const handoff = body.handoff_epoch ?? null;
  if (handoff !== null && !(Number.isInteger(handoff) && (handoff as number) >= 0)) {
    return c.json({ error: 'bad_request', detail: 'handoff_epoch' }, 422);
  }
  const workerId = body.worker_id;
  const agent = agentOf(c.req.header('X-Fleet-Agent-Instance'), c.req.header('X-Fleet-Docker-Daemon'));
  const { ticket, hash } = newClaimTicket();
  const answer = await getDb(c.env).begin(async (tx): Promise<ClaimTicketAnswer | null> => {
    if (!await holdHost(tx, host.host_id, agent)) return null;
    await tx`DELETE FROM fleet_claim_tickets
      WHERE expires_at < NOW() OR (host_id = ${host.host_id} AND worker_id = ${workerId})`;
    const [row] = await tx<{ expires_at: Date }[]>`
      INSERT INTO fleet_claim_tickets (token_hash, host_id, worker_id, handoff_epoch, expires_at)
      VALUES (${hash}, ${host.host_id}, ${workerId}, ${handoff as number | null},
              NOW() + ${`${CLAIM_TICKET_MINUTES} minutes`}::interval)
      RETURNING expires_at`;
    return { ticket, expires_at: row.expires_at.toISOString() };
  });
  if (!answer) return c.json(agentConflict(host.host_id), 403);
  hlog.info('fleet claim ticket minted', { hostId: host.host_id, workerId, handoffEpoch: handoff });
  return c.json(answer);
});

hosts.post('/:id/report', hostAuth, async (c) => {
  const host: FleetHostRow = c.var.host;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.version !== 'string' || !Array.isArray(body.containers)) {
    return c.json({ error: 'bad_request', detail: 'version, containers' }, 422);
  }
  const agent = agentOf(c.req.header('X-Fleet-Agent-Instance'), c.req.header('X-Fleet-Docker-Daemon'), body);
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const containers: FleetHostContainer[] = body.containers.filter(isRecord).map((x) => {
    const c: FleetHostContainer = {
      worker_id: typeof x.worker_id === 'string' ? x.worker_id : '',
      image: typeof x.image === 'string' ? x.image : '',
      state: typeof x.state === 'string' ? x.state : '',
      started_at: typeof x.started_at === 'string' ? x.started_at : null,
    };
    const hold = text(x.hold, 40);
    if (hold) c.hold = hold;
    if (x.exit_code === null || Number.isInteger(x.exit_code)) c.exit_code = x.exit_code as number | null;
    const imageId = text(x.image_id, 100);
    if (imageId) c.image_id = imageId;
    return c;
  }).filter((x) => x.worker_id);
  // Only the host's own `{host}-{n}` workers: a report naming another host's
  // worker would make the roll pick it for a host that cannot replace it.
  const foreign = containers.filter((x) => !ownWorkerId(host.host_id, x.worker_id)).map((x) => x.worker_id);
  if (foreign.length) hlog.warn('fleet host report names workers it does not own; dropped', { hostId: host.host_id, foreign: foreign.slice(0, 10) });
  const own = containers.filter((x) => ownWorkerId(host.host_id, x.worker_id));
  const report: FleetHostReport = { version: body.version.slice(0, 64), containers: own };
  if (agent) {
    const raw = isRecord(body.agent) ? body.agent : {};
    const conflict = Array.isArray(raw.conflict) ? raw.conflict.filter((x): x is string => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, 128)) : [];
    report.agent = { instance_id: agent.instance_id, daemon_id: agent.daemon_id, ...(conflict.length ? { conflict } : {}) };
  }
  if (JSON.stringify(report).length > MAX_REPORT_BYTES) return c.json({ error: 'bad_request', detail: 'report too large' }, 422);
  const sql = getDb(c.env);
  const stored = await sql.begin(async (tx) => {
    if (!await holdHost(tx, host.host_id, agent)) return false;
    await tx`
      UPDATE fleet_hosts SET report = ${tx.json(report as unknown as JSONValue)}, version = ${report.version}, last_seen_at = NOW()
      WHERE host_id = ${host.host_id}`;
    return true;
  });
  if (!stored) return c.json(agentConflict(host.host_id), 403);
  return c.json({ ok: true });
});

export default hosts;
