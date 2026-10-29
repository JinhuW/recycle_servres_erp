// The Docker CLI, as the agent uses it.
//
// Through the CLI and the mounted socket rather than an SDK: nothing to
// install, and every command the agent runs is one an operator can paste.
// Each call answers an error string instead of throwing, so one failed
// `docker` never takes the loop down with it.

import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { containerName, type Container } from './plan.js';
import { isDigestRef } from './types.js';

export const LABEL_HOST = 'rs.fleet.host';
export const LABEL_WORKER = 'rs.fleet.worker';
export const LABEL_HANDOFF = 'rs.fleet.handoff_epoch';
/** Created with a claim ticket: `docker start` would claim with a spent one. */
export const LABEL_TICKET = 'rs.fleet.claim_ticket';

// The worker saves its session on SIGTERM; give it the time.
export const STOP_TIMEOUT_S = 30;

/** What every worker on this host is told. The host token is not among it. */
export interface WorkerEnv {
  url: string;
  hostId: string;
  /** Where the worker ships its structured events (`ai_eval` and the rest); none ships without it. */
  opensearch?: { url: string; index: string };
}

export interface RunSpec {
  worker_id: string;
  image: string;
  port: number;
  handoff_epoch?: number;
  /** The single-use claim ticket the ERP minted for this container. */
  ticket: string;
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
  /** The daemon's id (`docker info`), or null when it cannot be read. */
  daemonId?(): Promise<string | null>;
  /** Running containers, other than this one, that are fleet agents for `hostId`; null when unknown. */
  otherAgents?(hostId: string): Promise<string[] | null>;
}

/**
 * The `docker run` argv for a worker. The fleet variables and the worker id
 * are named without a value: the CLI copies them from its own environment, so
 * the ticket never appears in a process list or a log line. `--` ends the
 * options, so no image name can be read as one.
 *
 * The container gets a claim ticket, never the host token: a worker runs
 * Chromium on Facebook, and the host token claims any free account on the
 * host and confirms its siblings stopped. The ticket also goes out as
 * RS_FLEET_HOST_TOKEN, the only name a worker image before facebook-tracker
 * 0.14.5 claims with; the ERP takes either on the claim.
 */
export function runArgs(hostId: string, spec: RunSpec, env?: WorkerEnv): string[] {
  const handoff = spec.handoff_epoch !== undefined;
  return [
    'run', '-d',
    '--name', containerName(spec.worker_id),
    '--label', `${LABEL_HOST}=${hostId}`,
    '--label', `${LABEL_WORKER}=${spec.worker_id}`,
    ...(handoff ? ['--label', `${LABEL_HANDOFF}=${spec.handoff_epoch}`] : []),
    '--label', `${LABEL_TICKET}=1`,
    '--restart', 'no',
    '--shm-size', '1g',
    '-e', 'RS_FLEET_URL',
    '-e', 'RS_FLEET_HOST_ID',
    '-e', 'RS_FLEET_CLAIM_TICKET',
    '-e', 'RS_FLEET_HOST_TOKEN',
    '-e', 'RS_FLEET_WORKER_ID',
    '-e', `RS_VNC_PORT=${spec.port}`,
    ...(handoff ? ['-e', `RS_FLEET_HANDOFF_EPOCH=${spec.handoff_epoch}`] : []),
    ...(env?.opensearch ? ['-e', 'AIMM_OPENSEARCH_URL', '-e', 'AIMM_OPENSEARCH_INDEX'] : []),
    '-p', `127.0.0.1:${spec.port}:5900`,
    '--',
    spec.image,
  ];
}

export function runEnv(spec: RunSpec, env: WorkerEnv): Record<string, string> {
  return {
    RS_FLEET_URL: env.url,
    RS_FLEET_HOST_ID: env.hostId,
    RS_FLEET_CLAIM_TICKET: spec.ticket,
    RS_FLEET_HOST_TOKEN: spec.ticket,
    RS_FLEET_WORKER_ID: spec.worker_id,
    ...(env.opensearch ? { AIMM_OPENSEARCH_URL: env.opensearch.url, AIMM_OPENSEARCH_INDEX: env.opensearch.index } : {}),
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

const NO_SUCH_CONTAINER = /no such container/i;

export class DockerCli implements DockerApi {
  constructor(
    private readonly runner: Runner = defaultRunner,
    private readonly selfHostname: string = hostname(),
  ) {}

  async call(args: string[], timeoutMs = 120_000, env?: Record<string, string>): Promise<[true, string] | [false, string]> {
    const done = await this.runner(args, { timeoutMs, env });
    if (done.code !== 0) {
      const lines = (done.stderr || done.stdout || '').trim().split('\n').filter(Boolean);
      const last = lines.length ? lines[lines.length - 1] : `exit ${done.code}`;
      return [false, `docker ${args.filter((a) => a !== '--').slice(0, 2).join(' ')}: ${last}`];
    }
    return [true, done.stdout];
  }

  async observe(hostId: string): Promise<Container[] | null> {
    // Once more when the list changed between `ps` and `inspect`.
    for (let attempt = 0; attempt < 2; attempt++) {
      const [ok, out] = await this.call(['ps', '-a', '-q', '--no-trunc', '--filter', `label=${LABEL_HOST}=${hostId}`]);
      if (!ok) return null;
      const ids = out.split('\n').map((l) => l.trim()).filter(Boolean);
      if (!ids.length) return [];
      const [ok2, raw] = await this.call(['inspect', ...ids]);
      if (!ok2) continue;
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
    return null;
  }

  /**
   * A digest is immutable: present is enough. A tag can be pushed again, so it
   * is pulled every time and the local copy is used only when the registry
   * cannot be reached.
   */
  async ensureImage(image: string): Promise<string | null> {
    if (isDigestRef(image)) {
      const [present] = await this.call(['image', 'inspect', '--', image], 30_000);
      if (present) return null;
      const [ok, out] = await this.call(['pull', '--', image], 900_000);
      return ok ? null : out;
    }
    const [pulled, out] = await this.call(['pull', '--', image], 900_000);
    if (pulled) return null;
    const [present] = await this.call(['image', 'inspect', '--', image], 30_000);
    return present ? null : out;
  }

  async run(spec: RunSpec, env: WorkerEnv): Promise<string | null> {
    const [ok, out] = await this.call(runArgs(env.hostId, spec, env), 300_000, runEnv(spec, env));
    return ok ? null : out;
  }

  async start(name: string): Promise<string | null> {
    const [ok, out] = await this.call(['start', name]);
    return ok ? null : out;
  }

  /** Stop, then remove; a container that is already gone counts as removed. */
  async stopAndRemove(name: string): Promise<string | null> {
    const [ok, out] = await this.call(['stop', '-t', String(STOP_TIMEOUT_S), name], (STOP_TIMEOUT_S + 60) * 1000);
    if (!ok) return NO_SUCH_CONTAINER.test(out) ? null : out;
    const [ok2, out2] = await this.call(['rm', name]);
    return ok2 || NO_SUCH_CONTAINER.test(out2) ? null : out2;
  }

  async daemonId(): Promise<string | null> {
    const [ok, out] = await this.call(['info', '--format', '{{.ID}}'], 30_000);
    const id = out.trim();
    return ok && id ? id : null;
  }

  async otherAgents(hostId: string): Promise<string[] | null> {
    // Workers carry the host label and agents do not: inspect only the rest.
    const [ok, out] = await this.call(['ps', '--no-trunc', '--format', `{{.ID}} {{.Label "${LABEL_HOST}"}}`]);
    if (!ok) return null;
    const ids = out.split('\n').map((l) => l.trim().split(' ')).filter((p) => p[0] && !p[1]).map((p) => p[0]);
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
    const others: string[] = [];
    for (const r of records as Record<string, any>[]) {
      const env: unknown = r?.Config?.Env;
      if (!Array.isArray(env) || !env.includes(`FLEET_HOST_ID=${hostId}`)) continue;
      if (!env.some((e) => typeof e === 'string' && e.startsWith('FLEET_HOST_TOKEN='))) continue;
      if (r?.Config?.Hostname === this.selfHostname) continue;
      others.push(String(r.Name ?? r.Id ?? '').replace(/^\//, ''));
    }
    return others;
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
    ...(typeof r.Id === 'string' ? { id: r.Id } : {}),
    ...(typeof r.Image === 'string' ? { image_id: r.Image } : {}),
    ...(labels[LABEL_HANDOFF] !== undefined ? { handoff: true } : {}),
    ...(labels[LABEL_TICKET] !== undefined ? { ticket: true } : {}),
  };
}
