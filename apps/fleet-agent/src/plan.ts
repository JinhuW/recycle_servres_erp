// From the desired state and the containers on the host to a list of actions.
//
// Pure: no Docker, no network, no clock of its own. Every rule that decides
// whether a Facebook worker is started or stopped lives here, where it can be
// tested without a daemon. The restraint matters more than the reach:
//
// * Not authoritative: nothing. Observe-only hosts start and stop nothing.
// * Offline (the desired state is a cached copy): exited workers may be
//   restarted, nothing is created, removed or replaced. Blind is not the time
//   to change things.
// * A worker that exited 78 stays stopped, online or not: it could not
//   connect, and every restart would be one more login into the same failure.
// * One start per tick, and never within the stagger of the previous one:
//   each start is a Facebook login, and ten from one host at once is a
//   pattern worth not showing.

import type { Desired } from './types.js';

export const CONTAINER_PREFIX = 'rs-fleet-';
export const DEFAULT_STAGGER_MS = 3 * 60_000;
export const CRASH_WINDOW_MS = 30 * 60_000;
export const CRASH_LIMIT = 5;

// Worker exit codes the image contract defines and what the agent owes each.
export const EXIT_STALE_OR_NO_SLOT = 75;
export const EXIT_CLAIM_FAILED = 70;
// The worker could not reach Facebook or its proxy and stopped on purpose. A
// retry is another login against the same wall, so only a person starts it
// again (`docker start`, or `docker rm` to let the agent run a fresh one).
export const EXIT_OPERATOR_NEEDED = 78;
/** What the report says for a worker left for an operator, in place of docker's `exited`. */
export const OPERATOR_NEEDED_STATE = 'operator_needed';
const RESTART_DELAY_MS: Record<number, number> = {
  [EXIT_STALE_OR_NO_SLOT]: 60_000,
  [EXIT_CLAIM_FAILED]: 10 * 60_000,
};
const RESTART_DELAY_OTHER_MS = 60_000;

/** A container carrying this host's label, as observed. */
export interface Container {
  name: string;
  worker_id: string;
  image: string;
  status: string;
  running: boolean;
  exit_code: number | null;
  started_at: string | null;
  finished_at: string | null;
}

export type Action =
  | { kind: 'run'; worker_id: string; container: string; image: string; port: number; reason: string }
  | { kind: 'start'; worker_id: string; container: string; reason: string; counted: boolean }
  | { kind: 'replace'; worker_id: string; container: string; image: string; port: number; reason: string }
  | { kind: 'remove'; worker_id: string; container: string; reason: string };

export interface PlanInput {
  hostId: string;
  desired: Desired;
  containers: Container[];
  /** False when `desired` is the cached copy. */
  online: boolean;
  now: number;
  /** When this agent last started a worker, by any means; null if never. */
  lastStartAt: number | null;
  /** Restarts after an unexpected exit, per worker, newest last (ms). */
  restarts: Record<string, number[]>;
  staggerMs?: number;
}

export interface Plan {
  actions: Action[];
  /** What was seen and held back, for the log. */
  notes: string[];
}

export function containerName(workerId: string): string {
  return CONTAINER_PREFIX + workerId;
}

export function workerId(hostId: string, n: number): string {
  return `${hostId}-${n}`;
}

/** The `n` of `{host}-{n}`, or null for an id this host did not assign. */
export function workerIndex(hostId: string, id: string): number | null {
  const prefix = `${hostId}-`;
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(rest)) return null;
  return Number(rest);
}

export function vncPort(desired: Desired, id: string, n: number): number {
  // The ERP maps ports for the workers it knows; a worker it has not seen yet
  // gets the conventional one until it does.
  return desired.vnc_ports[id] ?? 5900 + n;
}

export function restartDelayMs(exitCode: number | null): number {
  return exitCode !== null && RESTART_DELAY_MS[exitCode] !== undefined
    ? RESTART_DELAY_MS[exitCode]
    : RESTART_DELAY_OTHER_MS;
}

/** True for an exit the contract did not define: it counts toward the crash limit. */
export function isCrash(exitCode: number | null): boolean {
  return exitCode !== EXIT_STALE_OR_NO_SLOT && exitCode !== EXIT_CLAIM_FAILED && exitCode !== EXIT_OPERATOR_NEEDED;
}

/** An exited worker that waits for a person, never for the agent. */
export function needsOperator(c: Container): boolean {
  return !c.running && c.exit_code === EXIT_OPERATOR_NEEDED;
}

export function recentRestarts(times: number[] | undefined, now: number): number[] {
  return (times ?? []).filter((t) => now - t < CRASH_WINDOW_MS);
}

export function plan(input: PlanInput): Plan {
  const { hostId, desired, containers, online, now, lastStartAt, restarts } = input;
  const staggerMs = input.staggerMs ?? DEFAULT_STAGGER_MS;
  const actions: Action[] = [];
  const notes: string[] = [];

  if (!desired.authoritative) {
    if (containers.length || desired.count) notes.push('not authoritative: observing only');
    return { actions, notes };
  }

  // Two containers claiming one worker id is a hand's work, not the agent's;
  // it leaves both alone and says so.
  const byId = new Map<string, Container>();
  const duplicates = new Set<string>();
  for (const c of containers) {
    if (workerIndex(hostId, c.worker_id) === null) {
      notes.push(`${c.name}: worker id ${JSON.stringify(c.worker_id)} is not one this host assigns; left alone`);
      continue;
    }
    if (byId.has(c.worker_id)) {
      notes.push(`${c.worker_id}: more than one container (${byId.get(c.worker_id)!.name}, ${c.name}); left alone`);
      duplicates.add(c.worker_id);
      continue;
    }
    byId.set(c.worker_id, c);
  }
  for (const id of duplicates) byId.delete(id);

  // Extras go first and all at once: stopping is not a login.
  const extras = [...byId.values()]
    .filter((c) => workerIndex(hostId, c.worker_id)! > desired.count)
    .sort((a, b) => workerIndex(hostId, b.worker_id)! - workerIndex(hostId, a.worker_id)!);
  for (const c of extras) {
    if (!online) {
      notes.push(`${c.worker_id}: beyond count ${desired.count} but offline; kept`);
      continue;
    }
    actions.push({ kind: 'remove', worker_id: c.worker_id, container: c.name, reason: `beyond count ${desired.count}` });
  }

  const startAllowed = lastStartAt === null || now - lastStartAt >= staggerMs;
  let started = false;
  const takeStart = (): boolean => {
    if (started) return false;
    if (!startAllowed) return false;
    started = true;
    return true;
  };
  if (!startAllowed) {
    notes.push(`last start ${Math.round((now - (lastStartAt as number)) / 1000)} s ago; next in ${Math.ceil((staggerMs - (now - (lastStartAt as number))) / 1000)} s`);
  }

  let deferredReplace: Action | null = null;
  for (let n = 1; n <= desired.count; n++) {
    const id = workerId(hostId, n);
    if (duplicates.has(id)) continue;
    const current = byId.get(id);
    if (!current) {
      if (!online) continue;
      if (!takeStart()) {
        notes.push(`${id}: missing; waits for its turn`);
        continue;
      }
      actions.push({ kind: 'run', worker_id: id, container: containerName(id), image: desired.image, port: vncPort(desired, id, n), reason: 'missing' });
      continue;
    }
    if (current.running) {
      if (online && desired.roll?.replace === id && current.image !== desired.image) {
        deferredReplace = { kind: 'replace', worker_id: id, container: current.name, image: desired.image, port: vncPort(desired, id, n), reason: `image ${current.image} -> ${desired.image}` };
      }
      continue;
    }
    if (needsOperator(current)) {
      notes.push(`${id}: exit ${EXIT_OPERATOR_NEEDED}, cannot connect; left stopped for an operator`);
      continue;
    }
    // Exited: how long ago, and has it been doing this a lot.
    const finished = current.finished_at ? Date.parse(current.finished_at) : NaN;
    const sinceExit = Number.isFinite(finished) ? now - finished : Infinity;
    const delay = restartDelayMs(current.exit_code);
    const crash = isCrash(current.exit_code);
    if (sinceExit < delay) {
      notes.push(`${id}: exit ${current.exit_code} ${Math.round(sinceExit / 1000)} s ago; restart after ${delay / 1000} s`);
      continue;
    }
    if (crash && recentRestarts(restarts[id], now).length >= CRASH_LIMIT) {
      notes.push(`${id}: ${CRASH_LIMIT} restarts in ${CRASH_WINDOW_MS / 60_000} min (last exit ${current.exit_code}); left stopped`);
      continue;
    }
    if (!takeStart()) {
      notes.push(`${id}: exit ${current.exit_code}; restart waits for its turn`);
      continue;
    }
    actions.push({ kind: 'start', worker_id: id, container: current.name, reason: `exit ${current.exit_code}`, counted: crash });
  }

  if (deferredReplace) {
    if (takeStart()) actions.push(deferredReplace);
    else notes.push(`${deferredReplace.worker_id}: replacement waits for its turn`);
  }
  return { actions, notes };
}
