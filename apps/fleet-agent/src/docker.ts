// The Docker CLI, as the agent uses it.
//
// Through the CLI and the mounted socket rather than an SDK: nothing to
// install, and every command the agent runs is one an operator can paste.
// Each call answers an error string instead of throwing, so one failed
// `docker` never takes the loop down with it.

import { execFile } from 'node:child_process';
import { containerName, type Container } from './plan.js';

export const LABEL_HOST = 'rs.fleet.host';
export const LABEL_WORKER = 'rs.fleet.worker';

// The worker saves its session on SIGTERM; give it the time.
export const STOP_TIMEOUT_S = 30;

export interface WorkerEnv {
  url: string;
  hostId: string;
  token: string;
}

export interface RunSpec {
  worker_id: string;
  image: string;
  port: number;
  handoff_epoch?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (args: string[], opts: { timeoutMs: number; env?: Record<string, string> }) => Promise<RunResult>;

export interface DockerApi {
  /** Every container carrying this host's label; null when the daemon cannot be asked. */
  observe(hostId: string): Promise<Container[] | null>;
  ensureImage(image: string): Promise<string | null>;
  run(spec: RunSpec, env: WorkerEnv): Promise<string | null>;
  start(name: string): Promise<string | null>;
  stopAndRemove(name: string): Promise<string | null>;
}

/**
 * The `docker run` argv for a worker. The three fleet variables and the worker
 * id are named without a value: the CLI copies them from its own environment,
 * so the host token never appears in a process list or a log line.
 */
export function runArgs(hostId: string, spec: RunSpec): string[] {
  return [
    'run', '-d',
    '--name', containerName(spec.worker_id),
    '--label', `${LABEL_HOST}=${hostId}`,
    '--label', `${LABEL_WORKER}=${spec.worker_id}`,
    '--restart', 'no',
    '--shm-size', '1g',
    '-e', 'RS_FLEET_URL',
    '-e', 'RS_FLEET_HOST_ID',
    '-e', 'RS_FLEET_HOST_TOKEN',
    '-e', 'RS_FLEET_WORKER_ID',
    '-e', `RS_VNC_PORT=${spec.port}`,
    ...(spec.handoff_epoch !== undefined ? ['-e', `RS_FLEET_HANDOFF_EPOCH=${spec.handoff_epoch}`] : []),
    '-p', `127.0.0.1:${spec.port}:5900`,
    spec.image,
  ];
}

export function runEnv(spec: RunSpec, env: WorkerEnv): Record<string, string> {
  return {
    RS_FLEET_URL: env.url,
    RS_FLEET_HOST_ID: env.hostId,
    RS_FLEET_HOST_TOKEN: env.token,
    RS_FLEET_WORKER_ID: spec.worker_id,
  };
}

const defaultRunner: Runner = (args, opts) =>
  new Promise((resolve) => {
    execFile(
      'docker',
      args,
      { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...(opts.env ?? {}) } },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code !== 'number') {
          // Not an exit status: the binary is missing, or the call timed out.
          resolve({ code: null, stdout: String(stdout ?? ''), stderr: (error as Error).message });
          return;
        }
        resolve({ code: error ? Number((error as NodeJS.ErrnoException).code) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

export class DockerCli implements DockerApi {
  constructor(private readonly runner: Runner = defaultRunner) {}

  async call(args: string[], timeoutMs = 120_000, env?: Record<string, string>): Promise<[true, string] | [false, string]> {
    const done = await this.runner(args, { timeoutMs, env });
    if (done.code !== 0) {
      const lines = (done.stderr || done.stdout || '').trim().split('\n').filter(Boolean);
      const last = lines.length ? lines[lines.length - 1] : `exit ${done.code}`;
      return [false, `docker ${args.slice(0, 2).join(' ')}: ${last}`];
    }
    return [true, done.stdout];
  }

  async observe(hostId: string): Promise<Container[] | null> {
    const [ok, out] = await this.call(['ps', '-a', '-q', '--no-trunc', '--filter', `label=${LABEL_HOST}=${hostId}`]);
    if (!ok) return null;
    const ids = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!ids.length) return [];
    const [ok2, raw] = await this.call(['inspect', ...ids]);
    if (!ok2) return null;
    let records: unknown;
    try {
      records = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(records)) return null;
    const found: Container[] = [];
    for (const record of records) {
      const c = containerOf(record);
      if (c) found.push(c);
    }
    return found;
  }

  async ensureImage(image: string): Promise<string | null> {
    const [present] = await this.call(['image', 'inspect', image], 30_000);
    if (present) return null;
    const [ok, out] = await this.call(['pull', image], 900_000);
    return ok ? null : out;
  }

  async run(spec: RunSpec, env: WorkerEnv): Promise<string | null> {
    const [ok, out] = await this.call(runArgs(env.hostId, spec), 300_000, runEnv(spec, env));
    return ok ? null : out;
  }

  async start(name: string): Promise<string | null> {
    const [ok, out] = await this.call(['start', name]);
    return ok ? null : out;
  }

  async stopAndRemove(name: string): Promise<string | null> {
    const [ok, out] = await this.call(['stop', '-t', String(STOP_TIMEOUT_S), name], (STOP_TIMEOUT_S + 60) * 1000);
    if (!ok) return out;
    const [ok2, out2] = await this.call(['rm', name]);
    return ok2 ? null : out2;
  }
}

const NEVER = '0001-01-01T00:00:00Z';

export function containerOf(record: unknown): Container | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, any>;
  const labels: Record<string, string> = r.Config?.Labels ?? {};
  const id = labels[LABEL_WORKER];
  if (!id) return null;
  const state = r.State ?? {};
  const running = Boolean(state.Running);
  return {
    name: String(r.Name ?? '').replace(/^\//, ''),
    worker_id: String(id),
    image: String(r.Config?.Image ?? ''),
    status: String(state.Status ?? (running ? 'running' : 'exited')),
    running,
    exit_code: running ? null : Number.isInteger(state.ExitCode) ? state.ExitCode : null,
    started_at: state.StartedAt && state.StartedAt !== NEVER ? String(state.StartedAt) : null,
    finished_at: state.FinishedAt && state.FinishedAt !== NEVER ? String(state.FinishedAt) : null,
  };
}
