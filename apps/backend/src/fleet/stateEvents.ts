import type { FleetEngineLoss, FleetEngineLossRow } from '@recycle-erp/shared';
import type { SqlLike } from '../db';
import { bad, type Refusal } from './sql';

// ─── Worker state history and account loss per browser engine ────────────────
// fleet_workers.state keeps only the latest report; fleet_worker_state_events
// keeps each change, stamped with the slot's engine at that moment, so the
// loss rate of one engine can be held against another's.

const MAX_REASON = 200;
const MAX_LOSS_DAYS = 365;

/** Records the worker's new state when it differs from the one it had. Runs in
 *  the heartbeat's transaction, before the state is written. */
export async function recordStateChange(
  tx: SqlLike, w: { worker_id: string; account_no: number }, state: string, detail: unknown,
): Promise<void> {
  const [prev] = await tx<{ state: string | null }[]>`
    SELECT state FROM fleet_workers WHERE worker_id = ${w.worker_id} FOR UPDATE`;
  const from = prev?.state ?? null;
  if (from === state) return;
  const raw = detail && typeof detail === 'object' ? (detail as Record<string, unknown>).reason : null;
  const reason = typeof raw === 'string' ? raw.slice(0, MAX_REASON) : null;
  await tx`
    INSERT INTO fleet_worker_state_events (account_no, worker_id, engine, from_state, to_state, reason)
    SELECT ${w.account_no}, ${w.worker_id},
           COALESCE((SELECT device->>'browser_engine' FROM fleet_slots WHERE account_no = ${w.account_no}), 'stock'),
           ${from}, ${state}, ${reason}`;
}

export function readLossDays(q: Record<string, string | undefined>): number | Refusal {
  if (q.days === undefined) return 30;
  const days = Number(q.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_LOSS_DAYS) return bad(`days must be a whole number from 1 to ${MAX_LOSS_DAYS}`);
  return days;
}

const per100 = (losses: number, accountDays: number): number | null =>
  accountDays > 0 ? Math.round((losses / accountDays) * 10000) / 100 : null;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Account loss per browser engine over the last `days` (a rolling window
 * ending `now`).
 *
 * - **Account-days**: the time ERP-fleet accounts spent on a worker, from
 *   their fb_worker_accounts stints (a stint counts when its worker has state
 *   events for that account, which tells an ERP-fleet stint from a homelab
 *   one), clipped to the window, in days. Each stretch is credited to the
 *   engine of the account's latest state event at that time; the stretch
 *   before an account's first event takes that first event's engine.
 * - **Losses**: entries into SESSION_EXPIRED, CHECKPOINT or CHALLENGE_* in the
 *   window, by the engine stamped on the event. An entry whose account's
 *   previous event was already one of them is the same loss seen again (a
 *   parked worker rebooted, or moved from CHECKPOINT to SESSION_EXPIRED), and
 *   does not count twice.
 * - **retro**: the same arithmetic over every fb_worker_accounts stint (both
 *   fleets, all stock) with stints ending `problem` or `retired` as the
 *   losses, so a baseline exists before state events have accumulated.
 */
export async function engineLoss(sql: SqlLike, days: number, now = new Date()): Promise<FleetEngineLoss> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const exposure = await sql<{ engine: string; account_days: number }[]>`
    WITH ev AS (
      SELECT account_no, worker_id, engine, at,
             row_number() OVER (PARTITION BY account_no ORDER BY at, id) AS n,
             lead(at) OVER (PARTITION BY account_no ORDER BY at, id) AS next_at
      FROM fleet_worker_state_events WHERE account_no IS NOT NULL
    ), segs AS (
      SELECT account_no, engine,
             CASE WHEN n = 1 THEN '-infinity'::timestamptz ELSE at END AS a,
             COALESCE(next_at, 'infinity'::timestamptz) AS b
      FROM ev
    ), stints AS (
      SELECT s.account_no, GREATEST(s.started_at, ${since}::timestamptz) AS a,
             LEAST(COALESCE(s.ended_at, ${now}::timestamptz), ${now}::timestamptz) AS b
      FROM fb_worker_accounts s
      WHERE s.started_at < ${now} AND COALESCE(s.ended_at, ${now}::timestamptz) > ${since}
        AND EXISTS (SELECT 1 FROM ev WHERE ev.account_no = s.account_no AND lower(ev.worker_id) = lower(s.worker_id))
    )
    SELECT g.engine,
           SUM(EXTRACT(EPOCH FROM (LEAST(st.b, g.b) - GREATEST(st.a, g.a)))) / 86400 AS account_days
    FROM stints st JOIN segs g ON g.account_no = st.account_no AND g.a < st.b AND g.b > st.a
    GROUP BY g.engine`;
  const losses = await sql<{ engine: string; to_state: string; losses: number }[]>`
    WITH ev AS (
      SELECT account_no, engine, to_state, at,
             lag(to_state) OVER (PARTITION BY account_no ORDER BY at, id) AS prev_state
      FROM fleet_worker_state_events
    ), lost AS (
      SELECT * FROM ev
      WHERE at >= ${since} AND at < ${now}
        AND (to_state IN ('SESSION_EXPIRED', 'CHECKPOINT') OR to_state LIKE 'CHALLENGE%')
        AND NOT COALESCE(prev_state IN ('SESSION_EXPIRED', 'CHECKPOINT') OR prev_state LIKE 'CHALLENGE%', FALSE)
    )
    SELECT engine, to_state, COUNT(*)::int AS losses
    FROM lost GROUP BY engine, to_state`;

  const byEngine = new Map<string, FleetEngineLossRow>();
  const row = (engine: string): FleetEngineLossRow => {
    let r = byEngine.get(engine);
    if (!r) {
      r = { engine, account_days: 0, losses: {}, total_losses: 0, losses_per_100_account_days: null };
      byEngine.set(engine, r);
    }
    return r;
  };
  row('stock');
  row('cloak');
  for (const e of exposure) row(e.engine).account_days = round2(Number(e.account_days));
  for (const l of losses) {
    const r = row(l.engine);
    r.losses[l.to_state] = l.losses;
    r.total_losses += l.losses;
  }
  for (const r of byEngine.values()) r.losses_per_100_account_days = per100(r.total_losses, r.account_days);

  const [retro] = await sql<{ account_days: number; problem: number; retired: number }[]>`
    SELECT
      COALESCE(SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(ended_at, ${now}::timestamptz), ${now}::timestamptz)
                                       - GREATEST(started_at, ${since}::timestamptz)))) / 86400, 0) AS account_days,
      COUNT(*) FILTER (WHERE outcome = 'problem' AND ended_at >= ${since} AND ended_at < ${now})::int AS problem,
      COUNT(*) FILTER (WHERE outcome = 'retired' AND ended_at >= ${since} AND ended_at < ${now})::int AS retired
    FROM fb_worker_accounts
    WHERE started_at < ${now} AND COALESCE(ended_at, ${now}::timestamptz) > ${since}`;
  const retroDays = round2(Number(retro.account_days));
  const retroTotal = retro.problem + retro.retired;

  return {
    days,
    since: since.toISOString(),
    engines: [...byEngine.values()],
    retro: {
      engine: 'stock',
      account_days: retroDays,
      losses: { problem: retro.problem, retired: retro.retired },
      total_losses: retroTotal,
      losses_per_100_account_days: per100(retroTotal, retroDays),
    },
  };
}
