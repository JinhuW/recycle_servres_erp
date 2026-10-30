// One tick: desired state in, docker commands out, a report back.
//
//   1. GET the desired state; offline, use the cached copy and say so once;
//      refused (401/403/404), observe only
//   2. observe the containers carrying this host's label, and look for a
//      second agent for this host on the same daemon
//   3. plan (plan.ts); apply unless observe-only
//   4. online: report what the host runs
//
// Observe-only is the ERP's call (`authoritative: false`), or this agent's
// when another agent for the same host runs beside it: the tick plans and
// logs what it would do, and runs nothing.

import type { FleetClient } from './client.js';
import type { DockerApi, WorkerEnv } from './docker.js';
import { type Logger, silentLogger } from './log.js';
import { holdOf, plan, recentRestarts, workerIndex, type Action, type Container } from './plan.js';
import { loadDesired, loadInstanceId, loadMemory, saveDesired, saveMemory, type Memory, type StopIdentity } from './state.js';
import { EMPTY_DESIRED, imageAllowed, type AgentIdentity, type Desired, type Report } from './types.js';

// While a long pull or a row of stops runs, the ERP still hears from the host.
export const KEEPALIVE_MS = 60_000;

export interface AgentOptions {
  hostId: string;
  stateDir: string;
  client: FleetClient;
  docker: DockerApi;
  workerEnv: WorkerEnv;
  version: string;
  now?: () => number;
  staggerMs?: number;
  log?: Logger;
  /** Repositories this host runs; unset, any well-formed reference. */
  imagePrefixes?: string[];
  keepaliveMs?: number;
}

export interface TickResult {
  online: boolean;
  observe_only: boolean;
  refused: boolean;
  conflict: string[];
  desired: Desired;
  actions: Action[];
  applied: Action[];
  errors: string[];
  containers: Container[];
  reported: boolean;
}

export class Agent {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly bootAt: number;
  private readonly instanceId: string;
  private daemonId: string | null = null;
  private memory: Memory;
  private offlineSince: number | null = null;
  private refusedSince: number | null = null;
  private lastNotes = new Set<string>();
  private lastConflict = '';

  constructor(private readonly o: AgentOptions) {
    this.now = o.now ?? (() => Date.now());
    this.log = o.log ?? silentLogger;
    this.bootAt = this.now();
    this.memory = loadMemory(o.stateDir);
    this.instanceId = loadInstanceId(o.stateDir);
    o.client.identify?.(this.identity());
  }

  private identity(): AgentIdentity {
    return { instance_id: this.instanceId, daemon_id: this.daemonId };
  }

  async tick(): Promise<TickResult> {
    const errors: string[] = [];
    if (this.daemonId === null && this.o.docker.daemonId) {
      this.daemonId = await this.o.docker.daemonId();
      if (this.daemonId) this.o.client.identify?.(this.identity());
    }
    const answer = await this.o.client.desired();
    const refused = answer === 'refused';
    const fresh = answer !== null && answer !== 'refused' ? answer : null;
    const online = fresh !== null;
    let desired: Desired;
    if (fresh) {
      desired = fresh;
      try {
        saveDesired(this.o.stateDir, fresh);
      } catch (e) {
        errors.push(`could not cache the desired state: ${(e as Error).message}`);
      }
      if (this.offlineSince !== null || this.refusedSince !== null) {
        this.log.info('back online', { offline_s: Math.round((this.now() - (this.offlineSince ?? this.refusedSince!)) / 1000) });
        this.offlineSince = null;
        this.refusedSince = null;
      }
    } else if (refused) {
      // A deleted host or a revoked token: the cache is no licence to act.
      desired = EMPTY_DESIRED;
      if (this.refusedSince === null) {
        this.refusedSince = this.now();
        this.log.warn('desired state refused by the ERP; observing only');
      }
    } else {
      const cached = loadDesired(this.o.stateDir);
      desired = cached ?? EMPTY_DESIRED;
      if (this.offlineSince === null) {
        this.offlineSince = this.now();
        this.log.warn('desired state unavailable', { using: cached ? 'cached copy' : 'nothing', authoritative: desired.authoritative, count: desired.count });
      }
    }
    const result: TickResult = { online, observe_only: !desired.authoritative, refused, conflict: [], desired, actions: [], applied: [], errors, containers: [], reported: false };

    const observed = await this.o.docker.observe(this.o.hostId);
    if (observed === null) {
      // No report either: an empty list would read as "no workers".
      this.log.error('docker unreachable; nothing planned');
      errors.push('docker unreachable');
      return result;
    }
    result.containers = observed;

    // Two agents for one host would each count the other's starts as missing
    // and confirm stops the other has not made.
    const others = (await this.o.docker.otherAgents?.(this.o.hostId)) ?? [];
    result.conflict = others;
    const key = others.join(',');
    if (key !== this.lastConflict) {
      if (others.length) this.log.error('another fleet agent for this host runs on this daemon; observing only', { others });
      else if (this.lastConflict) this.log.info('no other fleet agent for this host any more');
      this.lastConflict = key;
    }
    if (others.length) errors.push(`another agent for this host: ${key}`);
    const observeOnly = !desired.authoritative || others.length > 0;
    result.observe_only = observeOnly;

    this.tidy(observed);
    if (online && !others.length) await this.settlePending(desired, observed);

    const now = this.now();
    const planned = plan({
      hostId: this.o.hostId,
      desired: others.length ? { ...desired, authoritative: false } : desired,
      containers: observed,
      online,
      now,
      lastStartAt: this.memory.last_start_at,
      restarts: this.memory.restarts,
      softRestarts: this.memory.soft_restarts,
      held: this.memory.held,
      selfStopped: this.memory.self_stopped,
      bootAt: this.bootAt,
      imageAllowed: imageAllowed(desired.image, this.o.imagePrefixes),
      staggerMs: this.o.staggerMs,
      restarting: Object.entries(this.memory.pending).filter(([, p]) => p.restart && p.confirmed).map(([id]) => id),
    });
    result.actions = planned.actions;
    if (Object.keys(planned.holds).length) {
      Object.assign(this.memory.held, planned.holds);
      this.save('holds');
    }
    this.logNotes(planned.notes);

    if (observeOnly) {
      for (const a of planned.actions) this.log.info('held', { ...a });
    } else if (planned.actions.length) {
      const keepalive = online
        ? setInterval(() => void this.o.client.report(this.payload(observed, others)), this.o.keepaliveMs ?? KEEPALIVE_MS)
        : null;
      try {
        for (const action of planned.actions) {
          const problem = await this.apply(action, desired);
          if (problem) {
            errors.push(`${action.worker_id}: ${problem}`);
            this.log.error('failed', { ...action, error: problem });
          } else {
            result.applied.push(action);
            this.log.info(action.kind, { ...action });
          }
        }
      } finally {
        if (keepalive) clearInterval(keepalive);
      }
      const after = await this.o.docker.observe(this.o.hostId);
      if (after) result.containers = after;
    }

    if (online) {
      result.reported = await this.o.client.report(this.payload(result.containers, others));
      if (!result.reported) this.log.warn('report not taken');
    }
    return result;
  }

  private payload(containers: Container[], others: string[]): Report {
    const holdInput = { held: this.memory.held, selfStopped: this.memory.self_stopped, bootAt: this.bootAt };
    return {
      version: this.o.version,
      containers: [...containers]
        .sort((a, b) => a.worker_id.localeCompare(b.worker_id, undefined, { numeric: true }))
        .map((c) => {
          const hold = holdOf(c, holdInput);
          return {
            worker_id: c.worker_id,
            image: c.image,
            state: hold ?? c.status,
            started_at: c.started_at,
            ...(hold ? { hold } : {}),
            exit_code: c.exit_code,
            ...(c.image_id ? { image_id: c.image_id } : {}),
          };
        }),
      agent: { ...this.identity(), ...(others.length ? { conflict: others } : {}) },
    };
  }

  /** Forgets holds and stop marks whose container is gone or running again. */
  private tidy(observed: Container[]): void {
    let changed = false;
    for (const [id, h] of Object.entries(this.memory.held)) {
      if (!observed.some((c) => c.worker_id === id && c.id === h.container && !c.running)) {
        delete this.memory.held[id];
        changed = true;
      }
    }
    for (const id of Object.keys(this.memory.self_stopped)) {
      if (!observed.some((c) => c.worker_id === id && !c.running)) {
        delete this.memory.self_stopped[id];
        changed = true;
      }
    }
    if (changed) this.save('tidy');
  }

  private async settlePending(desired: Desired, observed: Container[]): Promise<void> {
    for (const [id, pending] of Object.entries(this.memory.pending)) {
      // Above the count is no reason to drop the restart: hosts never remove
      // a worker, so a stopped one was stopped to be replaced. Observe-only,
      // nothing will run it.
      if (workerIndex(this.o.hostId, id) === null || !desired.authoritative) pending.restart = false;
      const exists = observed.some((c) => c.worker_id === id);
      // A container for the id again after a confirmed stop: the replacement
      // was run and the handoff is spent.
      if (pending.confirmed && exists) {
        delete this.memory.pending[id];
        this.save('pending');
      } else if (!pending.restart && !exists && await this.acknowledge(id, pending)) {
        delete this.memory.pending[id];
        this.save('pending');
      }
    }
  }

  private async apply(action: Action, desired: Desired): Promise<string | null> {
    const d = this.o.docker;
    switch (action.kind) {
      case 'start': {
        const withheld = this.stampStart(action);
        if (withheld) return withheld;
        return d.start(action.container);
      }
      case 'run': {
        const pending = this.memory.pending[action.worker_id];
        if (pending) {
          pending.confirmed = true;
          this.save('pending');
          if (!await this.acknowledge(action.worker_id, pending)) return 'stop confirmation not accepted';
        }
        const missing = await d.ensureImage(action.image);
        if (missing) return `image ${action.image} is not available: ${missing}`;
        return this.runWorker(action);
      }
      case 'replace': {
        // The image first: a pull that fails must leave the old worker running.
        const missing = await d.ensureImage(action.image);
        if (missing) return `image ${action.image} is not available: ${missing}`;
        const stopped = await this.stop(action, desired);
        if (stopped) return `could not replace ${action.container}: ${stopped}`;
        return this.runWorker(action);
      }
    }
  }

  private async runWorker(action: Extract<Action, { kind: 'run' | 'replace' }>): Promise<string | null> {
    const handoff = this.memory.pending[action.worker_id]?.restart ? this.memory.pending[action.worker_id].epoch : undefined;
    // Before the start is stamped: without a ticket nothing runs, and nothing
    // that did not run was a login.
    const ticket = await this.o.client.ticket(action.worker_id, handoff);
    if (!ticket) return 'no claim ticket from the ERP; not started';
    const withheld = this.stampStart(action);
    if (withheld) return withheld;
    const problem = await this.o.docker.run(
      { worker_id: action.worker_id, image: action.image, port: action.port, ticket, ...(handoff !== undefined ? { handoff_epoch: handoff } : {}) },
      this.o.workerEnv,
    );
    if (!problem) {
      delete this.memory.pending[action.worker_id];
      this.save('pending');
    }
    return problem;
  }

  private async stop(action: Action, desired: Desired): Promise<string | null> {
    const id = action.worker_id;
    // The action names a container that exists, so a confirmed stop from
    // before is spent: that container is its replacement.
    if (this.memory.pending[id]?.confirmed) delete this.memory.pending[id];
    const lease = desired.leases?.[id];
    if (!this.memory.pending[id] && lease) this.memory.pending[id] = { ...lease, restart: true };
    const pending = this.memory.pending[id];
    if (pending) pending.restart = true;
    this.memory.self_stopped[id] = this.now();
    // Unrecorded, a stop could not be confirmed after an agent restart; leave
    // the browser untouched instead.
    if (!this.save('stop')) return 'cannot record the stop under /state; left running';
    const problem = await this.o.docker.stopAndRemove(action.container);
    if (problem) return problem;
    if (pending) {
      pending.confirmed = true;
      this.save('pending');
      if (!await this.acknowledge(id, pending)) return 'stop confirmation not accepted';
    }
    return null;
  }

  private async acknowledge(id: string, identity: StopIdentity): Promise<boolean> {
    const response = await this.o.client.stopped?.(id, identity);
    if (response === 'stale') {
      // A pool edit or park superseded this handoff after Docker stopped.
      // Recreate without its old reservation; claim still enforces eligibility.
      delete this.memory.pending[id];
      this.save('pending');
    }
    return response === true || response === 'stale';
  }

  /**
   * Written down before the start, not after: a start whose answer is lost (a
   * CLI timeout, this agent stopped mid-call) was still a login. A start that
   * cannot be written down is not made.
   */
  private stampStart(action: Extract<Action, { kind: 'run' | 'start' | 'replace' }>): string | null {
    const now = this.now();
    this.memory.last_start_at = now;
    const id = action.worker_id;
    if (action.kind !== 'run') {
      if (action.counted) this.memory.restarts[id] = [...recentRestarts(this.memory.restarts[id], now), now];
      if (action.soft) this.memory.soft_restarts[id] = [...recentRestarts(this.memory.soft_restarts[id], now), now];
    }
    for (const list of [this.memory.restarts, this.memory.soft_restarts]) {
      for (const key of Object.keys(list)) {
        const kept = recentRestarts(list[key], now);
        if (kept.length) list[key] = kept;
        else delete list[key];
      }
    }
    return this.save('start') ? null : 'start withheld: cannot record it under /state';
  }

  private save(what: string): boolean {
    try {
      saveMemory(this.o.stateDir, this.memory);
      return true;
    } catch (e) {
      this.log.error('could not save memory', { what, error: (e as Error).message });
      return false;
    }
  }

  /** Each note once while it holds; a changing count of seconds is the same note. */
  private logNotes(notes: string[]): void {
    const now = new Set<string>();
    for (const note of notes) {
      const key = note.replace(/\b\d+ s\b/g, '# s');
      now.add(key);
      if (!this.lastNotes.has(key)) this.log.info('note', { note });
    }
    this.lastNotes = now;
  }
}
