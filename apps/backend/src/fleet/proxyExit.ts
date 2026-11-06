import { FLEET_EXIT_FRESH_MS, fleetExitPointText, type FleetProxySource } from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { notifyManagers } from '../lib/notify';

// ─── Where a proxy comes out ──────────────────────────────────────────────────
// A port is not an identity: the provider can move it to another IP or city at
// any time. Each measurement is compared with the port's last good one, and a
// difference becomes a durable row. This only reports. A device or timezone on
// a live slot is never rewritten because of it.

export type ProxyCheckRow = {
  exit: string; source: FleetProxySource; proxy_id: number | null; workers: string[];
  ok: boolean; latency_ms: number | null; exit_ip: string | null; city: string | null;
  region: string | null; country: string | null; org: string | null; timezone: string | null; error: string | null;
};

type Geo = { city: string | null; region: string | null; country: string | null; timezone: string | null };
type Measured = Geo & { exit_ip: string | null };

export type ProxyExitMeasure = { ok: boolean; exit_ip: string | null; timezone: string | null; fresh: boolean; measured_at: Date };

/**
 * The newest check of a listed proxy, whatever it found and however old: a
 * failed one has ok false and no IP, so a caller can refuse rather than use an
 * old exit. Null when the proxy has never been checked.
 */
export async function latestProxyExit(tx: SqlLike, proxyId: number): Promise<ProxyExitMeasure | null> {
  const [row] = await tx<ProxyExitMeasure[]>`
    SELECT ok, exit_ip, timezone, checked_at AS measured_at,
           checked_at > NOW() - make_interval(secs => ${FLEET_EXIT_FRESH_MS / 1000}) AS fresh
    FROM fleet_proxy_checks
    WHERE source = 'erp' AND proxy_id = ${proxyId}
    ORDER BY checked_at DESC, id DESC
    LIMIT 1`;
  return row ?? null;
}

/** The newest reading of the proxy `proxy` names, for a LATERAL. A failed ERP check stores no IP. */
export const latestExitOf = (sql: SqlLike, proxy: ReturnType<SqlLike>) => sql`
  SELECT c.exit_ip, c.timezone FROM fleet_proxy_checks c
  WHERE c.source = 'erp' AND c.proxy_id = ${proxy} AND c.exit_ip IS NOT NULL
  ORDER BY c.checked_at DESC, c.id DESC LIMIT 1`;

/**
 * The IP a port last exited from, whichever side checks it, for a LATERAL. Each
 * side is its own index lookup, as this runs for every port on every claim.
 */
export const latestExitIpOf = (sql: SqlLike, url: ReturnType<SqlLike>) => sql`
  SELECT x.exit_ip FROM (
    (SELECT c.exit_ip, c.checked_at FROM fleet_proxy_checks c
     WHERE c.source = 'erp' AND c.exit = ${url} AND c.ok AND c.exit_ip IS NOT NULL
     ORDER BY c.checked_at DESC, c.id DESC LIMIT 1)
    UNION ALL
    (SELECT c.exit_ip, c.checked_at FROM fleet_proxy_checks c
     WHERE c.source = 'coordinator' AND c.exit = ${url} AND c.ok AND c.exit_ip IS NOT NULL
     ORDER BY c.checked_at DESC, c.id DESC LIMIT 1)
  ) x ORDER BY x.checked_at DESC LIMIT 1`;

/** The IP to stamp on a stint going out through `url`, or null if it was never measured. */
export async function exitIpForStint(sql: SqlLike, url: string): Promise<string | null> {
  const [row] = await sql<{ exit_ip: string }[]>`${latestExitIpOf(sql, sql`${url}::text`)}`;
  return row?.exit_ip ?? null;
}

/**
 * Whether slot `s` belongs to a pilot account that hasn't opened Facebook yet,
 * on an exit the pilot wouldn't accept: a different IP or geo from the one
 * recorded at enrollment, or one another slot also uses. No measurement holds
 * nothing here; `exitUnknown` covers that. This runs for every free slot on
 * every claim, so the measurements sit behind the primary key lookup and the
 * two column tests, and only the few rows they let through reach them.
 */
export const firstLoginHeld = (sql: SqlLike) => sql`EXISTS (
  SELECT 1 FROM fleet_pilot_enrollments e
  CROSS JOIN LATERAL (${latestExitOf(sql, sql`s.proxy_id`)}) latest
  WHERE e.account_no = s.account_no AND e.pilot_id IS NOT NULL AND e.first_login_at IS NULL
    AND (e.exit_ip <> latest.exit_ip
      OR (latest.timezone IS NOT NULL AND e.exit_timezone IS NOT NULL AND latest.timezone <> e.exit_timezone)
      OR EXISTS (
        SELECT 1 FROM fleet_slots other
        CROSS JOIN LATERAL (${latestExitOf(sql, sql`other.proxy_id`)}) theirs
        WHERE other.account_no <> s.account_no AND theirs.exit_ip = latest.exit_ip)))`;

/**
 * Whether slot `s` needs an expected exit and its listed proxy has none, as
 * after a URL edit until the next round. A slot on an unlisted proxy has no
 * checks to wait for, so it isn't held to this.
 */
export const exitUnknown = (sql: SqlLike) => sql`(
  s.proxy_id IS NOT NULL
  AND (s.device->>'browser_engine' IS NOT DISTINCT FROM 'cloak' OR EXISTS (
    SELECT 1 FROM fleet_pilot_enrollments e
    WHERE e.account_no = s.account_no AND e.pilot_id IS NOT NULL AND e.first_login_at IS NULL))
  AND NOT EXISTS (
    SELECT 1 FROM fleet_proxy_checks c
    WHERE c.source = 'erp' AND c.proxy_id = s.proxy_id AND c.exit_ip IS NOT NULL))`;

/**
 * A slot no worker can be given yet, for the claim and for counting workers alike.
 * `exhausted` is proxyMarks' answer, read once by the caller: a claim is a login,
 * and one through a burned IP waits for the rotation.
 */
export const slotWaits = (sql: SqlLike, exhausted: readonly number[]) => sql`(
  s.proxy_id = ANY(${exhausted as number[]}::int[]) OR ${firstLoginHeld(sql)} OR ${exitUnknown(sql)})`;

export function hostPort(exit: string): { host: string; port: number } {
  const m = /^[a-z0-9]+:\/\/(.+?)(?::(\d+))?$/i.exec(exit);
  return { host: m?.[1] ?? exit, port: Number(m?.[2] ?? 0) };
}

const portKey = (exit: string) => { const { host, port } = hostPort(exit); return `${host}:${port}`; };

/**
 * Whether two good measurements name different exits. A geo field missing on
 * either side says nothing, or the rows from before the zone was kept would
 * all read as changed on the first round.
 */
export function exitMoved(before: Measured, after: Measured): boolean {
  if (before.exit_ip !== after.exit_ip) return true;
  return (['city', 'region', 'country', 'timezone'] as const)
    .some((k) => before[k] !== null && after[k] !== null && before[k] !== after[k]);
}

type Baseline = Measured & { exit: string; source: FleetProxySource; proxy_id: number | null; checked_at: Date };

/**
 * Records every exit change among `rows`, the checks about to be stored at
 * `at`, then alerts. Call it before inserting them, in their transaction.
 */
export async function recordExitChanges(tx: SqlLike, rows: ProxyCheckRow[], at: Date): Promise<void> {
  // A round and a manager's Check now could otherwise both see the old exit.
  await tx`SELECT pg_advisory_xact_lock(hashtext('fleet_proxy_exit_changes'))`;
  const listed = await tx<{ id: number; host: string; port: number; slots: number[]; replaced_exit: Baseline | null }[]>`
    SELECT p.id, p.host, p.port, p.replaced_exit,
           COALESCE(ARRAY_AGG(s.account_no ORDER BY s.account_no) FILTER (WHERE s.account_no IS NOT NULL), '{}') AS slots
    FROM fleet_proxies p LEFT JOIN fleet_slots s ON s.proxy_id = p.id
    GROUP BY p.id`;
  const listedPorts = new Set(listed.map((p) => `${p.host}:${p.port}`));
  const slotsOn = new Map(listed.map((p) => [p.id, p.slots]));
  const replaced = new Map(listed.filter((p) => p.replaced_exit).map((p) => [p.id, { ...p, was: p.replaced_exit! }]));

  // A port on both lists is one port, recorded on its ERP row. Its homelab
  // workers come from this round, or the last one the console answered when
  // this is a single proxy's Check now.
  const homelab = new Map<string, string[]>();
  const lastPorts = await tx<{ exit: string; workers: string[] }[]>`
    SELECT exit, workers FROM fleet_proxy_checks
    WHERE source = 'coordinator' AND checked_at = (SELECT coordinator_at FROM fleet_proxy_rounds)`;
  for (const r of [...lastPorts, ...rows.filter((c) => c.source === 'coordinator')]) homelab.set(portKey(r.exit), r.workers);

  const readings = rows.filter((r) => r.ok && r.exit_ip
    && (r.source === 'erp' ? r.proxy_id !== null : !listedPorts.has(portKey(r.exit))));
  const key = (r: { source: FleetProxySource; proxy_id: number | null; exit: string }) => `${r.source}:${r.proxy_id ?? r.exit}`;
  // Failed checks are skipped, so a port that fails and recovers on the same
  // exit compares with what it had before. A round's rows carry the time it
  // started, and a Check now may have landed since: that one is not its past.
  const erpIds = readings.filter((r) => r.source === 'erp').map((r) => r.proxy_id!);
  const coordinatorExits = readings.filter((r) => r.source === 'coordinator').map((r) => r.exit);
  // Each port's own lookup: this runs under the lock every round, and sorting 14
  // days of checks to keep one row per port took 200 times as long.
  const baselineOf = (where: ReturnType<SqlLike>) => tx`
    SELECT c.exit, c.source, c.proxy_id, c.checked_at, c.exit_ip, c.city, c.region, c.country, c.timezone
    FROM fleet_proxy_checks c
    WHERE c.ok AND c.exit_ip IS NOT NULL AND c.checked_at <= ${at} AND ${where}
    ORDER BY c.checked_at DESC, c.id DESC LIMIT 1`;
  const baselines = readings.length ? await tx<Baseline[]>`
    SELECT b.* FROM unnest(${erpIds}::int[]) port(id)
    CROSS JOIN LATERAL (${baselineOf(tx`c.source = 'erp' AND c.proxy_id = port.id`)}) b
    UNION ALL
    SELECT b.* FROM unnest(${tx.array(coordinatorExits)}::text[]) port(exit)
    CROSS JOIN LATERAL (${baselineOf(tx`c.source = 'coordinator' AND c.exit = port.exit`)}) b` : [];
  const before = new Map(baselines.map((b) => [key(b), b]));

  for (const r of readings) {
    // A row from under a URL edit names the old exit, and says nothing of the
    // new one. The first reading of the new one compares with what was kept.
    const edit = r.proxy_id === null ? undefined : replaced.get(r.proxy_id);
    const onEdited = !!edit && portKey(r.exit) === `${edit.host}:${edit.port}`;
    const was = onEdited ? edit.was : before.get(key(r));
    if (onEdited) await tx`UPDATE fleet_proxies SET replaced_exit = NULL WHERE id = ${r.proxy_id}`;
    if (!was || (!onEdited && was.exit !== r.exit) || !exitMoved(was, r)) continue;
    // A round and a Check now that overlap read the same past, so the lock
    // alone can't stop the second recording this move again.
    const [recorded] = await tx`
      SELECT 1 FROM fleet_proxy_exit_changes
      WHERE source = ${r.source} AND exit = ${r.exit} AND old_ip = ${was.exit_ip} AND new_ip = ${r.exit_ip}
        AND changed_at > ${was.checked_at} LIMIT 1`;
    if (recorded) continue;
    const slots = r.proxy_id === null ? [] : slotsOn.get(r.proxy_id) ?? [];
    const sharing = await tx<{ account_no: number }[]>`
      SELECT e.account_no FROM fleet_pilot_enrollments e
      JOIN fleet_slots s ON s.account_no = e.account_no
      CROSS JOIN LATERAL (${latestExitOf(tx, tx`s.proxy_id`)}) latest
      WHERE e.pilot_id IS NOT NULL AND latest.exit_ip = ${r.exit_ip} AND s.proxy_id IS DISTINCT FROM ${r.proxy_id}
      ORDER BY e.account_no`;
    await tx`
      INSERT INTO fleet_proxy_exit_changes (
        exit, source, proxy_id, changed_at, previous_at,
        old_ip, old_city, old_region, old_country, old_timezone,
        new_ip, new_city, new_region, new_country, new_timezone, slots, workers, shares_with)
      VALUES (${r.exit}, ${r.source}, ${r.proxy_id}, ${at}, ${was.checked_at},
              ${was.exit_ip}, ${was.city}, ${was.region}, ${was.country}, ${was.timezone},
              ${r.exit_ip}, ${r.city}, ${r.region}, ${r.country}, ${r.timezone},
              ${slots}::int[], ${tx.array(homelab.get(portKey(r.exit)) ?? [])}::text[], ${sharing.map((x) => x.account_no)}::int[])`;
  }
  // The account is on whatever its port exits from now, so a later failure
  // counts against that IP. This also fills in a stint the claim couldn't, on a
  // URL edited and not yet measured.
  if (readings.length) {
    await tx`
      UPDATE fb_worker_accounts w SET exit_ip = v.ip
      FROM unnest(${tx.array(readings.map((r) => r.exit))}::text[], ${tx.array(readings.map((r) => r.exit_ip!))}::text[]) v(exit, ip)
      WHERE w.proxy_url = v.exit AND w.ended_at IS NULL AND w.exit_ip IS DISTINCT FROM v.ip`;
  }
  await alertExitChanges(tx);
}

/**
 * At most one alert in this long. The first move alerts at once; the rest of a
 * remap spread over several rounds, or a port that keeps flapping, wait and
 * arrive together. The Proxies tab shows them meanwhile.
 */
const ALERT_GAP_MS = 30 * 60_000;
/** A port nobody uses still says how wide the remap was, if it moved this close to the rest. */
const REMAP_SPREAD_MS = 10 * 60_000;
const ALERT_LINES = 5;

export type PendingChange = {
  name: string; old_ip: string; new_ip: string;
  old_city: string | null; old_region: string | null; old_country: string | null; old_timezone: string | null;
  new_city: string | null; new_region: string | null; new_country: string | null; new_timezone: string | null;
  slots: number[]; workers: string[]; shares_with: number[];
};

const side = (ip: string, city: string | null, region: string | null, country: string | null, timezone: string | null) =>
  fleetExitPointText({ ip, city, region, country, timezone });

/** One notification for everything pending, however many ports it covers. */
export function exitAlertText(pending: readonly PendingChange[], unused: number): { title: string; body: string } {
  const slots = [...new Set(pending.flatMap((c) => c.slots))].sort((a, b) => a - b);
  const workers = [...new Set(pending.flatMap((c) => c.workers))].sort();
  const who = [slots.map((n) => `#${n}`).join(', '), workers.join(', ')].filter(Boolean).join('; ');
  const lines = pending.slice(0, ALERT_LINES).map((c) =>
    `${c.name}: ${side(c.old_ip, c.old_city, c.old_region, c.old_country, c.old_timezone)} → ${side(c.new_ip, c.new_city, c.new_region, c.new_country, c.new_timezone)}`);
  const more = pending.length - lines.length;
  const sharing = [...new Set(pending.flatMap((c) => c.shares_with))].sort((a, b) => a - b);
  const body = [
    ...(who ? [`On it: ${who}.`] : []),
    ...(sharing.length ? [`Now on the same exit as pilot account ${sharing.map((n) => `#${n}`).join(', ')}.`] : []),
    ...lines,
    ...(more > 0 ? [`And ${more} more on Fleet ▸ Proxies.`] : []),
    'No device or timezone was changed.',
  ].join('\n');
  const total = pending.length + unused;
  const title = total === 1
    ? `Proxy exit changed: ${pending[0]!.name}`
    : unused
      ? `${total} proxy exits changed, ${pending.length} with accounts on them`
      : `${total} proxy exits changed under accounts`;
  return { title, body };
}

async function alertExitChanges(tx: SqlLike): Promise<void> {
  const [gap] = await tx<{ recent: boolean }[]>`
    SELECT COALESCE(MAX(notified_at) > NOW() - make_interval(secs => ${ALERT_GAP_MS / 1000}), FALSE) AS recent
    FROM fleet_proxy_exit_changes`;
  if (gap.recent) return;
  const pending = await tx<(PendingChange & { id: string; changed_at: Date })[]>`
    SELECT c.id, COALESCE(p.label, c.exit) AS name, c.changed_at,
           c.old_ip, c.old_city, c.old_region, c.old_country, c.old_timezone,
           c.new_ip, c.new_city, c.new_region, c.new_country, c.new_timezone, c.slots, c.workers, c.shares_with
    FROM fleet_proxy_exit_changes c LEFT JOIN fleet_proxies p ON p.id = c.proxy_id
    WHERE c.notified_at IS NULL AND (CARDINALITY(c.slots) > 0 OR CARDINALITY(c.workers) > 0 OR CARDINALITY(c.shares_with) > 0)
    ORDER BY c.changed_at, c.id`;
  if (!pending.length) return;
  const [{ unused }] = await tx<{ unused: number }[]>`
    SELECT COUNT(*)::int AS unused FROM fleet_proxy_exit_changes
    WHERE CARDINALITY(slots) = 0 AND CARDINALITY(workers) = 0 AND CARDINALITY(shares_with) = 0
      AND changed_at >= ${new Date(pending[0]!.changed_at.getTime() - REMAP_SPREAD_MS)}`;
  await notifyManagers(tx, { kind: 'fleet_proxy_exit', tone: 'warn', icon: 'alert', ...exitAlertText(pending, unused) });
  await tx`UPDATE fleet_proxy_exit_changes SET notified_at = NOW() WHERE id = ANY(${pending.map((c) => c.id)}::bigint[])`;
}
