// Fleet visibility: each process periodically upserts one row in `workers`
// with when it started, when it last beat, and when each loop last succeeded.
// Observational only — nothing in the pipeline reads this table.

import type {Sql} from './db.ts';

export type WorkerRole = 'worker' | 'api';
export type LoopName = 'poll' | 'evaluate' | 'notify';

// Liveness thresholds, shared by the API's status filter and any UI: three
// missed 30s beats reads as stale, ten silent minutes as dead.
export const STALE_AFTER_S = 90;
export const DEAD_AFTER_S = 600;

export interface LoopStatus {
  lastSuccessAt: string | null;
  lastWorkAt: string | null;
}

const LOOP_NAMES: readonly LoopName[] = ['poll', 'evaluate', 'notify'];

/**
 * In-memory per-loop timestamps, flushed to the database by the heartbeat
 * loop. Loops report through `wrap()` so their own code stays untouched.
 */
export class LoopRegistry {
  private readonly loops: Record<LoopName, LoopStatus>;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.loops = Object.fromEntries(
      LOOP_NAMES.map((name) => [name, {lastSuccessAt: null, lastWorkAt: null}]),
    ) as Record<LoopName, LoopStatus>;
  }

  recordSuccess(loop: LoopName, didWork: boolean): void {
    const at = new Date(this.now()).toISOString();
    this.loops[loop].lastSuccessAt = at;
    if (didWork) this.loops[loop].lastWorkAt = at;
  }

  /** Wraps a loop iteration so completions are recorded and throws are not. */
  wrap(loop: LoopName, iteration: () => Promise<boolean>): () => Promise<boolean> {
    return async () => {
      const didWork = await iteration();
      this.recordSuccess(loop, didWork);
      return didWork;
    };
  }

  snapshot(): Record<LoopName, LoopStatus> {
    return structuredClone(this.loops);
  }
}

export interface HeartbeatDeps {
  sql: Sql;
  workerId: string;
  role: WorkerRole;
  startedAt: Date;
  registry: LoopRegistry;
}

/** Upserts this process's worker row. Always reports idle to its loop. */
export async function heartbeatOnce(deps: HeartbeatDeps): Promise<boolean> {
  const {sql} = deps;
  await sql`
    INSERT INTO workers (worker_id, role, started_at, last_heartbeat_at, loops)
    VALUES (${deps.workerId}, ${deps.role}, ${deps.startedAt}, NOW(),
            ${sql.json(deps.registry.snapshot() as never)})
    ON CONFLICT (worker_id) DO UPDATE
      SET role = EXCLUDED.role,
          started_at = EXCLUDED.started_at,
          last_heartbeat_at = NOW(),
          loops = EXCLUDED.loops`;
  return false;
}

/**
 * Deletes this process's row on clean shutdown, so intentional stops (deploys,
 * scale-downs) don't linger as "dead" in the fleet view. A crashed worker
 * skips this and stays visible — which is exactly the alert an operator wants.
 */
export async function removeWorker(sql: Sql, workerId: string): Promise<void> {
  await sql`DELETE FROM workers WHERE worker_id = ${workerId}`;
}
