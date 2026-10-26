// Containers in a map; every command recorded. The shim the agent tests run
// against instead of a daemon.

import type { DockerApi, RunSpec, WorkerEnv } from '../../src/docker.js';
import { containerName, type Container } from '../../src/plan.js';

export type Command = ['ensure', string] | ['run', string, string, number, WorkerEnv] | ['start', string] | ['stop+rm', string];

let serial = 0;

export class FakeDocker implements DockerApi {
  containers = new Map<string, Container>();
  images: Set<string>;
  reachable = true;
  commands: Command[] = [];
  /** Handoff epochs passed to each run, by container name. */
  handoffs: (number | undefined)[] = [];
  agents: string[] = [];
  /** What the next `run` / `start` / `stopAndRemove` answers, once; the effect still happens unless `effect` is false. */
  failNext: Partial<Record<'run' | 'start' | 'stop', { error: string; effect: boolean }>> = {};
  now: () => string = () => new Date().toISOString();

  constructor(containers: Container[] = [], images: string[] = ['img:1', 'img:2']) {
    for (const c of containers) this.containers.set(c.name, c);
    this.images = new Set(images);
  }

  async observe(hostId: string): Promise<Container[] | null> {
    if (!this.reachable) return null;
    return [...this.containers.values()].filter((c) => c.worker_id.startsWith(`${hostId}-`) || c.name.includes('stray'));
  }

  async ensureImage(image: string): Promise<string | null> {
    this.commands.push(['ensure', image]);
    return this.images.has(image) ? null : `pull access denied for ${image}`;
  }

  async run(spec: RunSpec, env: WorkerEnv): Promise<string | null> {
    this.commands.push(['run', containerName(spec.worker_id), spec.image, spec.port, env]);
    this.handoffs.push(spec.handoff_epoch);
    const fail = this.take('run');
    const name = containerName(spec.worker_id);
    if (this.containers.has(name)) return `docker run: Conflict. The container name "/${name}" is already in use`;
    if (!fail || fail.effect) {
      this.containers.set(name, { ...running(spec.worker_id, spec.image, this.now()), ...(spec.handoff_epoch !== undefined ? { handoff: true } : {}) });
    }
    return fail ? fail.error : null;
  }

  async start(name: string): Promise<string | null> {
    this.commands.push(['start', name]);
    const fail = this.take('start');
    const c = this.containers.get(name);
    if (!c) return `docker start: no such container ${name}`;
    if (!fail || fail.effect) {
      this.containers.set(name, { ...c, running: true, status: 'running', exit_code: null, started_at: this.now(), finished_at: null });
    }
    return fail ? fail.error : null;
  }

  async stopAndRemove(name: string): Promise<string | null> {
    this.commands.push(['stop+rm', name]);
    const fail = this.take('stop');
    if (fail) {
      if (fail.effect) this.containers.delete(name);
      return fail.error;
    }
    this.containers.delete(name);
    return null;
  }

  async daemonId(): Promise<string | null> {
    return 'fake-daemon';
  }

  async otherAgents(): Promise<string[] | null> {
    return this.agents;
  }

  private take(kind: 'run' | 'start' | 'stop') {
    const fail = this.failNext[kind];
    delete this.failNext[kind];
    return fail;
  }
}

export function running(workerId: string, image = 'img:1', startedAt = '2026-10-24T10:00:00Z'): Container {
  return { name: containerName(workerId), worker_id: workerId, image, status: 'running', running: true, exit_code: null, started_at: startedAt, finished_at: null, id: `c${++serial}` };
}

export function exited(workerId: string, exitCode: number, finishedAt: string, image = 'img:1'): Container {
  return { name: containerName(workerId), worker_id: workerId, image, status: 'exited', running: false, exit_code: exitCode, started_at: '2026-10-24T09:00:00Z', finished_at: finishedAt, id: `c${++serial}` };
}
