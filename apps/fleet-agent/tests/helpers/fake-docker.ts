// Containers in a map; every command recorded. The shim the agent tests run
// against instead of a daemon.

import type { DockerApi, RunSpec, WorkerEnv } from '../../src/docker.js';
import { containerName, type Container } from '../../src/plan.js';

export type Command = ['ensure', string] | ['run', string, string, number, WorkerEnv] | ['start', string] | ['stop+rm', string];

export class FakeDocker implements DockerApi {
  containers = new Map<string, Container>();
  images: Set<string>;
  reachable = true;
  commands: Command[] = [];
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
    this.containers.set(containerName(spec.worker_id), running(spec.worker_id, spec.image, this.now()));
    return null;
  }

  async start(name: string): Promise<string | null> {
    this.commands.push(['start', name]);
    const c = this.containers.get(name);
    if (!c) return `docker start: no such container ${name}`;
    this.containers.set(name, { ...c, running: true, status: 'running', exit_code: null, started_at: this.now(), finished_at: null });
    return null;
  }

  async stopAndRemove(name: string): Promise<string | null> {
    this.commands.push(['stop+rm', name]);
    if (!this.containers.delete(name)) return `docker stop: no such container ${name}`;
    return null;
  }
}

export function running(workerId: string, image = 'img:1', startedAt = '2026-10-24T10:00:00Z'): Container {
  return { name: containerName(workerId), worker_id: workerId, image, status: 'running', running: true, exit_code: null, started_at: startedAt, finished_at: null };
}

export function exited(workerId: string, exitCode: number, finishedAt: string, image = 'img:1'): Container {
  return { name: containerName(workerId), worker_id: workerId, image, status: 'exited', running: false, exit_code: exitCode, started_at: '2026-10-24T09:00:00Z', finished_at: finishedAt };
}
