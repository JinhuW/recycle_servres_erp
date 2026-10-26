// One tick: desired state in, docker commands out, a report back.
//
//   1. GET the desired state; offline, use the cached copy and say so once
//   2. observe the containers carrying this host's label
//   3. plan (plan.ts); apply unless observe-only
//   4. online: report what the host runs
//
// Observe-only is the ERP's call (`authoritative: false`): the tick plans and
// logs what it would do, and runs nothing.

import type { FleetClient } from './client.js';
import type { DockerApi, WorkerEnv } from './docker.js';
import { type Logger, silentLogger } from './log.js';
import { needsOperator, OPERATOR_NEEDED_STATE, plan, recentRestarts, type Action, type Container } from './plan.js';
import { loadDesired, loadMemory, saveDesired, saveMemory, type Memory, type StopIdentity } from './state.js';
import { EMPTY_DESIRED, type Desired, type Report } from './types.js';

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
}

export interface TickResult {
  online: boolean;
  observe_only: boolean;
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
  private memory: Memory;
  private offlineSince: number | null = null;

  constructor(private readonly o: AgentOptions) {
    this.now = o.now ?? (() => Date.now());
    this.log = o.log ?? silentLogger;
    this.memory = loadMemory(o.stateDir);
  }

  async tick(): Promise<TickResult> {
    const errors: string[] = [];
    const fresh = await this.o.client.desired();
    const online = fresh !== null;
    let desired: Desired;
    if (fresh) {
      desired = fresh;
      try {
        saveDesired(this.o.stateDir, fresh);
      } catch (e) {
        errors.push(`could not cache the desired state: ${(e as Error).message}`);
      }
      if (this.offlineSince !== null) {
        this.log.info('back online', { offline_s: Math.round((this.now() - this.offlineSince) / 1000) });
        this.offlineSince = null;
      }
    } else {
      const cached = loadDesired(this.o.stateDir);
      desired = cached ?? EMPTY_DESIRED;
      if (this.offlineSince === null) {
        this.offlineSince = this.now();
        this.log.warn('desired state unavailable', { using: cached ? 'cached copy' : 'nothing', authoritative: desired.authoritative, count: desired.count });
      }
    }
    const observeOnly = !desired.authoritative;
    const result: TickResult = { online, observe_only: observeOnly, desired, actions: [], applied: [], errors, containers: [], reported: false };

    const observed = await this.o.docker.observe(this.o.hostId);
    if (observed === null) {
      // No report either: an empty list would read as "no workers".
      this.log.error('docker unreachable; nothing planned');
      errors.push('docker unreachable');
      return result;
    }
    result.containers = observed;

    if (online && !observeOnly) {
      for (const [id, pending] of Object.entries(this.memory.pending)) {
        if (Number(id.slice(id.lastIndexOf('-') + 1)) > desired.count) pending.restart = false;
        if ((pending.confirmed && observed.some(c => c.worker_id === id && c.running)) || (!pending.restart && !observed.some(c => c.worker_id === id) && await this.acknowledge(id, pending))) {
          delete this.memory.pending[id];
          if (pending.restart) this.noteStart(null);
          saveMemory(this.o.stateDir, this.memory);
        }
      }
    }
    const now = this.now();
    const planned = plan({
      hostId: this.o.hostId,
      desired,
      containers: observed,
      online,
      now,
      lastStartAt: this.memory.last_start_at,
      restarts: this.memory.restarts,
      staggerMs: this.o.staggerMs,
    });
    result.actions = planned.actions;
    for (const note of planned.notes) this.log.info('note', { note });

    if (observeOnly) {
      for (const a of planned.actions) this.log.info('held', { ...a });
    } else {
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
      if (result.applied.length) {
        const after = await this.o.docker.observe(this.o.hostId);
        if (after) result.containers = after;
      }
    }

    if (online) {
      const payload: Report = {
        version: this.o.version,
        containers: [...result.containers]
          .sort((a, b) => a.worker_id.localeCompare(b.worker_id, undefined, { numeric: true }))
          .map((c) => ({ worker_id: c.worker_id, image: c.image, state: needsOperator(c) ? OPERATOR_NEEDED_STATE : c.status, started_at: c.started_at })),
      };
      result.reported = await this.o.client.report(payload);
      if (!result.reported) this.log.warn('report not taken');
    }
    return result;
  }

  private async apply(action: Action, desired: Desired): Promise<string | null> {
    const d = this.o.docker;
    switch (action.kind) {
      case 'remove':
        return this.stop(action, desired, false);
      case 'start': {
        const problem = await d.start(action.container);
        if (!problem) this.noteStart(action.counted ? action.worker_id : null);
        return problem;
      }
      case 'run': {
        const pending = this.memory.pending[action.worker_id];
        if (pending) {
          pending.confirmed = true;
          saveMemory(this.o.stateDir, this.memory);
          if (!await this.acknowledge(action.worker_id, pending)) return 'stop confirmation not accepted';
        }
        const missing = await d.ensureImage(action.image);
        if (missing) return `image ${action.image} is not available: ${missing}`;
        const problem = await d.run({ worker_id: action.worker_id, image: action.image, port: action.port, ...(this.memory.pending[action.worker_id]?.restart ? { handoff_epoch: this.memory.pending[action.worker_id].epoch } : {}) }, this.o.workerEnv);
        if (!problem) {
          delete this.memory.pending[action.worker_id];
          this.noteStart(action.reason.startsWith('exit ') ? action.worker_id : null);
        }
        return problem;
      }
      case 'replace': {
        // The image first: a pull that fails must leave the old worker running.
        const missing = await d.ensureImage(action.image);
        if (missing) return `image ${action.image} is not available: ${missing}`;
        const stopped = await this.stop(action, desired, true);
        if (stopped) return `could not replace ${action.container}: ${stopped}`;
        const problem = await d.run({ worker_id: action.worker_id, image: action.image, port: action.port, ...(this.memory.pending[action.worker_id]?.restart ? { handoff_epoch: this.memory.pending[action.worker_id].epoch } : {}) }, this.o.workerEnv);
        if (!problem) {
          delete this.memory.pending[action.worker_id];
          this.noteStart(action.reason.startsWith('exit ') ? action.worker_id : null);
        }
        return problem;
      }
    }
  }

  private async stop(action: Action, desired: Desired, restart: boolean): Promise<string | null> {
    const id = action.worker_id;
    const lease = desired.leases?.[id];
    if (!this.memory.pending[id] && lease) {
      this.memory.pending[id] = { ...lease, restart };
      // If persistence fails, leave the browser untouched.
      saveMemory(this.o.stateDir, this.memory);
    }
    const pending = this.memory.pending[id];
    if (!pending?.confirmed) {
      const problem = await this.o.docker.stopAndRemove(action.container);
      if (problem) return problem;
      if (pending) {
        pending.confirmed = true;
        saveMemory(this.o.stateDir, this.memory);
      }
    }
    if (pending && !await this.acknowledge(id, pending)) return 'stop confirmation not accepted';
    if (!restart) {
      delete this.memory.pending[id];
      saveMemory(this.o.stateDir, this.memory);
    }
    return null;
  }

  private async acknowledge(id: string, identity: StopIdentity): Promise<boolean> {
    const response = await this.o.client.stopped?.(id, identity);
    if (response === 'stale') {
      // A pool edit or park superseded this handoff after Docker stopped.
      // Recreate without its old reservation; claim still enforces eligibility.
      delete this.memory.pending[id];
      saveMemory(this.o.stateDir, this.memory);
    }
    return response === true || response === 'stale';
  }

  private noteStart(crashedWorker: string | null): void {
    const now = this.now();
    this.memory.last_start_at = now;
    if (crashedWorker) {
      this.memory.restarts[crashedWorker] = [...recentRestarts(this.memory.restarts[crashedWorker], now), now];
    }
    for (const id of Object.keys(this.memory.restarts)) {
      const kept = recentRestarts(this.memory.restarts[id], now);
      if (kept.length) this.memory.restarts[id] = kept;
      else delete this.memory.restarts[id];
    }
    try {
      saveMemory(this.o.stateDir, this.memory);
    } catch (e) {
      this.log.warn('could not save memory', { error: (e as Error).message });
    }
  }
}
