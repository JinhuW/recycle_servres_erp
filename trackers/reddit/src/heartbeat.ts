// Fleet visibility: each process periodically upserts one row in `workers`
// with when it started, when it last beat, and when each loop last succeeded.
// The same beat carries what has been going wrong: each loop's run of failed
// iterations (`loop_failures`) and every warn/error line since the last beat
// (`worker_errors`). Only the api's ops watch reads those (loops/watch.ts);
// nothing in the pipeline does.

import type {Sql} from './db.ts';

export type WorkerRole = 'worker' | 'api';
export type LoopName = 'poll' | 'evaluate' | 'notify';

// Liveness thresholds, shared by the API's status filter and any UI: three
// missed 30s beats reads as stale, ten silent minutes as dead.
export const STALE_AFTER_S = 90;
export const DEAD_AFTER_S = 600;

// Lines held while the database is unreachable. Past this they are counted,
// not kept: an outage long enough to fill it is reported as the worker being
// down anyway.
const MAX_BUFFERED_PROBLEMS = 200;

export interface LoopStatus {
  lastSuccessAt: string | null;
  lastWorkAt: string | null;
}

export interface LoopFailures {
  /** Iterations in a row that threw or logged a warn/error; 0 after a clean one. */
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface Problem {
  at: string;
  scope: string;
  level: 'warn' | 'error';
  message: string;
  fields: Record<string, unknown>;
}

const LOOP_NAMES: readonly LoopName[] = ['poll', 'evaluate', 'notify'];

function isLoopName(value: string): value is LoopName {
  return (LOOP_NAMES as readonly string[]).includes(value);
}

// Postgres keeps no NUL in TEXT or JSONB. One in an error message would get
// every beat after it refused, through `lastError` as much as the line itself.
function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [withoutNul(k), withoutNul(v)]));
  }
  return value;
}

/** "evaluation failed: 401 Unauthorized" — the message plus its error field. */
export function problemText(message: string, fields: Record<string, unknown>): string {
  const error = fields['error'];
  return error === undefined || error === null ? message : `${message}: ${String(error)}`;
}

/**
 * In-memory per-loop state, flushed to the database by the heartbeat loop.
 * Loops report through `wrap()` and the logger's problem hook, so their own
 * code stays untouched.
 */
export class LoopRegistry {
  private readonly loops: Record<LoopName, LoopStatus>;
  private readonly failures: Record<LoopName, LoopFailures>;
  // Loops whose current iteration has logged a problem.
  private readonly troubled = new Set<LoopName>();
  private problems: Problem[] = [];
  private dropped = 0;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.loops = Object.fromEntries(
      LOOP_NAMES.map((name) => [name, {lastSuccessAt: null, lastWorkAt: null}]),
    ) as Record<LoopName, LoopStatus>;
    this.failures = Object.fromEntries(
      LOOP_NAMES.map((name) => [name, {consecutiveFailures: 0, lastError: null, lastErrorAt: null}]),
    ) as Record<LoopName, LoopFailures>;
  }

  recordSuccess(loop: LoopName, didWork: boolean): void {
    const at = new Date(this.now()).toISOString();
    this.loops[loop].lastSuccessAt = at;
    if (didWork) this.loops[loop].lastWorkAt = at;
  }

  /**
   * The logger's problem hook. A line whose scope starts with a loop name (the
   * loops log through `logger.child('<loop>')`) also fails that loop's current
   * iteration: a per-post failure is only a warn inside an iteration that still
   * completes, and it is exactly what a dead API key looks like.
   */
  noteProblem(scope: string, level: 'warn' | 'error', rawMessage: string, rawFields: Record<string, unknown>): void {
    const at = new Date(this.now()).toISOString();
    const message = withoutNul(rawMessage) as string;
    // Through JSON first, as the logger prints them: a Date becomes its string.
    const fields = withoutNul(JSON.parse(JSON.stringify(rawFields))) as Record<string, unknown>;
    if (this.problems.length < MAX_BUFFERED_PROBLEMS) {
      this.problems.push({at, scope, level, message, fields});
    } else {
      this.dropped++;
    }
    const loop = scope.split(':')[0]!;
    if (isLoopName(loop)) {
      this.troubled.add(loop);
      this.failures[loop].lastError = problemText(message, fields);
      this.failures[loop].lastErrorAt = at;
    }
  }

  /** Wraps a loop iteration so completions and failures are recorded. */
  wrap(loop: LoopName, iteration: () => Promise<boolean>): () => Promise<boolean> {
    return async () => {
      this.troubled.delete(loop);
      let threw = true;
      try {
        const didWork = await iteration();
        threw = false;
        this.recordSuccess(loop, didWork);
        return didWork;
      } finally {
        const failed = threw || this.troubled.has(loop);
        this.failures[loop].consecutiveFailures = failed ? this.failures[loop].consecutiveFailures + 1 : 0;
      }
    };
  }

  snapshot(): Record<LoopName, LoopStatus> {
    return structuredClone(this.loops);
  }

  failureSnapshot(): Record<LoopName, LoopFailures> {
    return structuredClone(this.failures);
  }

  /** Problems not yet written, oldest first, and how many were dropped. */
  pendingProblems(): ProblemBatch {
    return {problems: [...this.problems], dropped: this.dropped};
  }

  /** Forgets a batch from `pendingProblems()` once it is stored. */
  ackProblems(batch: ProblemBatch): void {
    this.problems = this.problems.slice(batch.problems.length);
    this.dropped -= batch.dropped;
  }
}

export interface ProblemBatch {
  problems: Problem[];
  dropped: number;
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
  const {sql, registry} = deps;
  const batch = registry.pendingProblems();
  const problems = batch.dropped === 0 ? batch.problems : [...batch.problems, {
    at: new Date().toISOString(),
    scope: 'heartbeat',
    level: 'warn',
    message: 'problem lines dropped while the database was unreachable',
    fields: {count: batch.dropped},
  } satisfies Problem];
  await sql`
    INSERT INTO workers (worker_id, role, started_at, last_heartbeat_at, loops, loop_failures)
    VALUES (${deps.workerId}, ${deps.role}, ${deps.startedAt}, NOW(),
            ${sql.json(registry.snapshot() as never)},
            ${sql.json(registry.failureSnapshot() as never)})
    ON CONFLICT (worker_id) DO UPDATE
      SET role = EXCLUDED.role,
          started_at = EXCLUDED.started_at,
          last_heartbeat_at = NOW(),
          loops = EXCLUDED.loops,
          loop_failures = EXCLUDED.loop_failures`;
  if (problems.length === 0) return false;
  try {
    await sql`
      INSERT INTO worker_errors (worker_id, scope, level, message, fields, at)
      SELECT ${deps.workerId}, p.scope, p.level, p.message, p.fields, p.at
        FROM jsonb_to_recordset(${sql.json(problems as never)})
          AS p(scope TEXT, level TEXT, message TEXT, fields JSONB, at TIMESTAMPTZ)`;
  } finally {
    // The beat above just landed, so a refusal here is about these rows, not
    // the database; keeping them would fail every beat after. The throw still
    // reaches the runner, whose error line goes out with the next beat.
    registry.ackProblems(batch);
  }
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
