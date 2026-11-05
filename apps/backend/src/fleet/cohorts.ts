import {
  FLEET_PILOT_CLOAK_CAP,
  fleetSessionLost,
  type FleetCohortAccount, type FleetCohortCounts, type FleetCohortGroup, type FleetCohortOutcome, type FleetCohortReport, type FleetCohortSearches, type FleetCohortWindow, type FleetPilotArm,
} from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { loadSettings } from './cities';
import { readLossDays } from './stateEvents';
import { bad, searchRanToEnd, type Refusal } from './sql';
import { FLEET_HOLDER, PILOT_ID, PILOT_ID_RULE } from './workers';

// ─── Cohort report: pilot arms and the supplier scorecard ────────────────────
// docs/superpowers/plans/2026-11-04-cloakbrowser-launch-plan.md fixed these rules before the first account, so an arm can't
// be flattered afterwards. Numbers only: the verdict is the owner's.
//
// "Lost" is a stint that ended retired or problem, as the plan's 30-day figures
// were counted. A retire deletes the slot, so nothing here may depend on one
// existing; fb_worker_accounts and the enrollment both outlive it.

const HOUR_MS = 3_600_000;
const SHORT_HOURS = 24;
const LONG_HOURS = 7 * 24;

export type CohortQuery = { pilot: string | null; days: number };

export function readCohortQuery(q: Record<string, string | undefined>): CohortQuery | Refusal {
  const days = readLossDays(q);
  if (typeof days !== 'number') return days;
  if (q.pilot === undefined) return { pilot: null, days };
  if (!PILOT_ID.test(q.pilot)) return bad(PILOT_ID_RULE);
  return { pilot: q.pilot, days };
}

type Fact = {
  account_no: number;
  batch: string | null;
  pilot_id: string | null;
  arm: FleetPilotArm;
  known: boolean;
  enrolled_at: Date | null;
  clock: Date | null;
  lost_at: Date | null;
  released_at: Date | null;
  held_at: Date | null;
  healthy_at: Date | null;
  crossed_arm: boolean;
  state_short: string | null;
  state_long: string | null;
  searches: number;
  exit_changes: string[];
  outages: string[];
  recovery_boots: number;
};

/** Where the account stood when the window closed. The earliest ending wins: an
 *  account handed back at hour 5 and retired after a re-add never ran the clock
 *  out, so its later loss can't be charged to this window. */
export function outcomeAt(f: Fact, hours: number, now: Date): FleetCohortOutcome | null {
  if (!f.clock) return null;
  const end = f.clock.getTime() + hours * HOUR_MS;
  const lost = f.lost_at?.getTime() ?? Infinity;
  const left = Math.min(f.released_at?.getTime() ?? Infinity, f.held_at?.getTime() ?? Infinity);
  if (lost <= end && lost <= left) return 'lost';
  if (left <= end) return 'unknown';
  if (now.getTime() < end) return 'running';
  // A worker that never got HEALTHY isn't a survivor just because nobody has
  // retired it yet. Without state history (homelab workers, and anything from
  // before 2026-11-03) that can't be told, so the stint rule alone decides.
  if (f.known && (!f.healthy_at || f.healthy_at.getTime() > end)) return 'never_healthy';
  return 'survived';
}

/** Touched only if the event fell while the window ran: a move on day 5 says
 *  nothing about a 24-hour result. */
function flaggedIn(f: Fact, hours: number): boolean {
  if (!f.clock) return false;
  const start = f.clock.getTime();
  const end = Math.min(
    start + hours * HOUR_MS,
    f.lost_at?.getTime() ?? Infinity, f.released_at?.getTime() ?? Infinity, f.held_at?.getTime() ?? Infinity,
  );
  return [...f.exit_changes, ...f.outages].some((at) => {
    const t = new Date(at).getTime();
    return t >= start && t <= end;
  });
}

function counts(facts: Fact[], hours: number, now: Date): FleetCohortCounts {
  const c: FleetCohortCounts = { failed: 0, failed_pct: null, lost: 0, survived: 0, survived_in_loss_state: 0, never_healthy: 0, unknown: 0, running: 0, decided: 0, lost_pct: null };
  for (const f of facts) {
    const o = outcomeAt(f, hours, now);
    if (!o) continue;
    c[o] += 1;
    if (o === 'survived' && fleetSessionLost(hours === SHORT_HOURS ? f.state_short : f.state_long)) c.survived_in_loss_state += 1;
  }
  c.decided = c.lost + c.survived + c.never_healthy;
  // Retiring is a manual click, so `lost` alone runs late and misses a browser
  // that never started. `failed` is what the arm actually suffered; `lost` stays
  // the stint figure a supplier can be compared on, across history.
  c.failed = c.lost + c.never_healthy + c.survived_in_loss_state;
  const pct = (n: number) => (c.decided > 0 ? Math.round((n / c.decided) * 1000) / 10 : null);
  c.failed_pct = pct(c.failed);
  c.lost_pct = pct(c.lost);
  return c;
}

const windowOf = (facts: Fact[], hours: number, now: Date): FleetCohortWindow => ({
  all: counts(facts, hours, now),
  unflagged: counts(facts.filter((f) => !flaggedIn(f, hours)), hours, now),
});

/** A window still running, or ended early by the owner, is a partial count, so
 *  it stays out: a long-lived account mustn't look worse than a finished one. A
 *  lost account's short count stays in, since doing badly can't drop anyone. */
function searchesOf(facts: Fact[], now: Date): FleetCohortSearches {
  const whole = facts.filter((f) => {
    const o = outcomeAt(f, LONG_HOURS, now);
    return f.known && (o === 'lost' || o === 'survived' || o === 'never_healthy');
  });
  const searches = whole.reduce((sum, f) => sum + f.searches, 0);
  return { accounts: whole.length, searches, per_account: whole.length ? Math.round((searches / whole.length) * 10) / 10 : null };
}

function group(facts: Fact[], key: { pilot: string | null; batch: string | null; arm: FleetPilotArm }, now: Date): FleetCohortGroup {
  const claimed = facts.filter((f) => f.clock);
  return {
    ...key,
    claimed: claimed.length,
    never_claimed: facts.length - claimed.length,
    reached_healthy: claimed.filter((f) => f.healthy_at).length,
    health_unknown: claimed.filter((f) => !f.known).length,
    failed_starts: claimed.filter((f) => {
      if (!f.known || f.healthy_at) return false;
      const o = outcomeAt(f, SHORT_HOURS, now);
      return o === 'lost' || o === 'never_healthy';
    }).length,
    lost_24h: windowOf(claimed, SHORT_HOURS, now),
    lost_7d: windowOf(claimed, LONG_HOURS, now),
    searches: {
      all: searchesOf(claimed, now),
      unflagged: searchesOf(claimed.filter((f) => !flaggedIn(f, LONG_HOURS)), now),
    },
    exit_change_accounts: claimed.filter((f) => f.exit_changes.length > 0).length,
    outage_accounts: claimed.filter((f) => f.outages.length > 0).length,
    recovery_boots: claimed.reduce((sum, f) => sum + f.recovery_boots, 0),
  };
}

const armOrder = (a: FleetPilotArm) => (a === 'cloak' ? 0 : 1);

function groupsBy(facts: Fact[], key: (f: Fact) => { pilot: string | null; batch: string | null; arm: FleetPilotArm }, now: Date): FleetCohortGroup[] {
  const buckets = new Map<string, Fact[]>();
  for (const f of facts) {
    const k = JSON.stringify(key(f));
    const list = buckets.get(k);
    if (list) list.push(f);
    else buckets.set(k, [f]);
  }
  return [...buckets.entries()]
    .map(([k, list]) => group(list, JSON.parse(k) as ReturnType<typeof key>, now))
    .sort((a, b) => {
      if (a.batch !== b.batch) {
        if (a.batch === null) return 1;
        if (b.batch === null) return -1;
        return a.batch.localeCompare(b.batch);
      }
      return armOrder(a.arm) - armOrder(b.arm);
    });
}

const accountWire = (f: Fact, now: Date): FleetCohortAccount => ({
  account_no: f.account_no,
  batch: f.batch,
  arm: f.arm,
  enrolled_at: f.enrolled_at?.toISOString() ?? null,
  first_claimed_at: f.clock?.toISOString() ?? null,
  reached_healthy: f.clock && f.known ? f.healthy_at !== null : null,
  crossed_arm: f.crossed_arm,
  lost_at: f.lost_at?.toISOString() ?? null,
  outcome_24h: outcomeAt(f, SHORT_HOURS, now),
  outcome_7d: outcomeAt(f, LONG_HOURS, now),
  in_loss_state_24h: outcomeAt(f, SHORT_HOURS, now) === 'survived' && fleetSessionLost(f.state_short),
  in_loss_state_7d: outcomeAt(f, LONG_HOURS, now) === 'survived' && fleetSessionLost(f.state_long),
  searches_7d: f.clock && f.known ? f.searches : null,
  exit_changes: f.exit_changes.length,
  licence_outages: f.outages.length,
  recovery_boots: f.recovery_boots,
});

/**
 * With `pilot`: that pilot's enrollments, per batch and arm, with their accounts.
 * Without: every account first claimed in the last `days`, per batch and engine.
 *
 * The clock is the enrollment's first_claimed_at. An account from before
 * enrollment existed starts at its first stint on a real worker; a stint on the
 * shared "ERP fleet" holder only means the slot was made, not that anything ran.
 * Its engine is the one its history starts on, since the windows measure the
 * start of its life, and an arm is never re-derived from what happened later.
 */
export async function cohortReport(sql: SqlLike, q: CohortQuery, now = new Date()): Promise<FleetCohortReport> {
  const since = new Date(now.getTime() - q.days * 86_400_000);
  const scope = q.pilot !== null
    ? sql`c.pilot_id = ${q.pilot}`
    : sql`COALESCE(c.clock, c.enrolled_at) >= ${since} AND COALESCE(c.clock, c.enrolled_at) <= ${now}`;
  const rows = await sql<Fact[]>`
    WITH first_stint AS (
      SELECT account_no, MIN(started_at) AS at FROM fb_worker_accounts
      WHERE lower(worker_id) <> lower(${FLEET_HOLDER}) GROUP BY account_no
    ), cohort AS (
      SELECT COALESCE(e.account_no, f.account_no) AS account_no,
             COALESCE(e.batch, a.batch) AS batch,
             e.pilot_id, e.enrolled_at,
             CASE WHEN e.account_no IS NOT NULL THEN e.first_claimed_at ELSE f.at END AS clock,
             e.account_no IS NOT NULL AS enrolled,
             COALESCE(e.arm,
               (SELECT ev.engine FROM fleet_worker_state_events ev WHERE ev.account_no = f.account_no ORDER BY ev.at, ev.id LIMIT 1),
               a.browser_engine, 'stock') AS arm
      FROM fleet_pilot_enrollments e
      FULL JOIN first_stint f ON f.account_no = e.account_no
      LEFT JOIN fb_pool_accounts a ON a.no = COALESCE(e.account_no, f.account_no)
    )
    SELECT c.account_no, c.batch, c.pilot_id, c.arm, c.enrolled_at, c.clock,
      c.enrolled OR EXISTS (SELECT 1 FROM fleet_worker_state_events ev WHERE ev.account_no = c.account_no) AS known,
      (SELECT MIN(w.ended_at) FROM fb_worker_accounts w
        WHERE w.account_no = c.account_no AND w.outcome IN ('retired', 'problem') AND w.ended_at >= c.clock) AS lost_at,
      (SELECT MIN(w.ended_at) FROM fb_worker_accounts w
        WHERE w.account_no = c.account_no AND w.outcome IN ('available', 'taken', 'removed') AND w.ended_at >= c.clock) AS released_at,
      -- A manager's park clears the slot's worker, while a worker's own park
      -- keeps it. It stores no time, so the last sign of life stands in for one.
      CASE WHEN s.lease_expires_at = 'infinity'::timestamptz AND s.worker_id IS NULL AND c.clock IS NOT NULL THEN
        COALESCE(
          (SELECT MAX(fw.last_heartbeat_at) FROM fleet_workers fw WHERE fw.account_no = c.account_no),
          (SELECT MAX(ev.at) FROM fleet_worker_state_events ev WHERE ev.account_no = c.account_no),
          c.clock)
      END AS held_at,
      (SELECT MIN(ev.at) FROM fleet_worker_state_events ev
        WHERE ev.account_no = c.account_no AND ev.to_state = 'HEALTHY' AND ev.at >= c.clock
          AND (NOT c.enrolled OR ev.engine = c.arm)) AS healthy_at,
      c.enrolled AND EXISTS (SELECT 1 FROM fleet_worker_state_events ev
        WHERE ev.account_no = c.account_no AND ev.engine <> c.arm) AS crossed_arm,
      (SELECT ev.to_state FROM fleet_worker_state_events ev
        WHERE ev.account_no = c.account_no AND ev.at <= c.clock + make_interval(hours => ${SHORT_HOURS})
        ORDER BY ev.at DESC, ev.id DESC LIMIT 1) AS state_short,
      (SELECT ev.to_state FROM fleet_worker_state_events ev
        WHERE ev.account_no = c.account_no AND ev.at <= c.clock + make_interval(hours => ${LONG_HOURS})
        ORDER BY ev.at DESC, ev.id DESC LIMIT 1) AS state_long,
      (SELECT COUNT(*)::int FROM fleet_tasks t
        WHERE t.account_no = c.account_no AND t.state = 'done' AND t.kind = 'search'
          AND ${searchRanToEnd(sql)}
          AND t.done_at >= c.clock AND t.done_at < c.clock + make_interval(hours => ${LONG_HOURS})) AS searches,
      COALESCE((SELECT json_agg(x.changed_at ORDER BY x.changed_at) FROM fleet_proxy_exit_changes x
        WHERE x.changed_at >= c.clock AND x.changed_at <= c.clock + make_interval(hours => ${LONG_HOURS})
          AND (c.account_no = ANY(x.slots) OR c.account_no = ANY(x.shares_with) OR EXISTS (
            SELECT 1 FROM fb_worker_accounts w
            WHERE w.account_no = c.account_no AND lower(w.worker_id) IN (SELECT lower(u) FROM unnest(x.workers) u)
              AND w.started_at <= x.changed_at AND COALESCE(w.ended_at, 'infinity'::timestamptz) >= x.changed_at))), '[]'::json) AS exit_changes,
      COALESCE((SELECT json_agg(ev.at ORDER BY ev.at) FROM fleet_worker_state_events ev
        WHERE ev.account_no = c.account_no AND ev.to_state = 'DEAD' AND ev.reason = 'license_outage'
          AND ev.at >= c.clock AND ev.at <= c.clock + make_interval(hours => ${LONG_HOURS})), '[]'::json) AS outages,
      -- A claim resets the worker's state, so the first report after one has no
      -- from_state: that row is a boot.
      (SELECT COUNT(*)::int FROM (
        SELECT ev.at, ev.from_state, lag(ev.reason) OVER w AS prev_reason, lag(ev.to_state) OVER w AS prev_state
        FROM fleet_worker_state_events ev WHERE ev.account_no = c.account_no
        WINDOW w AS (ORDER BY ev.at, ev.id)
      ) b WHERE b.at >= c.clock AND b.from_state IS NULL AND b.prev_state = 'DEAD' AND b.prev_reason = 'license_outage') AS recovery_boots
    FROM cohort c
    LEFT JOIN fleet_slots s ON s.account_no = c.account_no
    WHERE ${scope}
    ORDER BY c.account_no`;

  const [seats] = await sql<{ active: number; parked: number }[]>`
    SELECT COUNT(*)::int AS active,
           COUNT(*) FILTER (WHERE lease_expires_at = 'infinity'::timestamptz)::int AS parked
    FROM fleet_slots WHERE device->>'browser_engine' = 'cloak'`;
  const settings = await loadSettings(sql);
  const pilots = await sql<{ pilot_id: string }[]>`
    SELECT DISTINCT pilot_id FROM fleet_pilot_enrollments WHERE pilot_id IS NOT NULL ORDER BY pilot_id`;

  return {
    pilot: q.pilot,
    days: q.pilot === null ? q.days : null,
    since: q.pilot === null ? since.toISOString() : null,
    pilots: pilots.map((p) => p.pilot_id),
    seats: { active: seats.active, parked: seats.parked, max_slots: settings.cloak_max_slots, pilot_cap: FLEET_PILOT_CLOAK_CAP },
    arms: groupsBy(rows, (f) => ({ pilot: q.pilot, batch: null, arm: f.arm }), now),
    groups: groupsBy(rows, (f) => ({ pilot: q.pilot, batch: f.batch, arm: f.arm }), now),
    accounts: q.pilot === null ? [] : rows.map((f) => accountWire(f, now)),
  };
}
