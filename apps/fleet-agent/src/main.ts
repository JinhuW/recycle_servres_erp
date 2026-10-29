// fleet-agent: keep this Docker host's Facebook workers as the ERP desires.
//
// Configured from the environment only: FLEET_URL, FLEET_HOST_ID,
// FLEET_HOST_TOKEN; FLEET_INTERVAL (seconds, default 30, at least 5),
// FLEET_STATE_DIR (default /state), FLEET_STAGGER_SECONDS (default 180; lower
// it only in tests), FLEET_IMAGE_PREFIX (comma-separated repositories the
// host runs, default ghcr.io/jinhuw/aimm-recycle), FLEET_OPENSEARCH_URL and
// FLEET_OPENSEARCH_INDEX (default fb-tracker) for the workers' events.

import { Agent } from './agent.js';
import { HttpFleetClient } from './client.js';
import { DockerCli } from './docker.js';
import { createLogger } from './log.js';
import { DEFAULT_STAGGER_MS } from './plan.js';
import { DEFAULT_IMAGE_PREFIX } from './types.js';
import { agentVersion } from './version.js';

const log = createLogger();

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

function seconds(name: string, fallback: number, min = 0): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    log.warn('ignoring a setting that is not a number of seconds', { name, value: raw, min });
    return fallback;
  }
  return n;
}

const missing = ['FLEET_URL', 'FLEET_HOST_ID', 'FLEET_HOST_TOKEN'].filter((n) => !env(n));
if (missing.length) {
  log.error('missing environment', { names: missing });
  process.exit(2);
}

const hostId = env('FLEET_HOST_ID');
const intervalMs = seconds('FLEET_INTERVAL', 30, 5) * 1000;
const staggerMs = seconds('FLEET_STAGGER_SECONDS', DEFAULT_STAGGER_MS / 1000) * 1000;
const version = agentVersion();
const opensearch = env('FLEET_OPENSEARCH_URL')
  ? { url: env('FLEET_OPENSEARCH_URL'), index: env('FLEET_OPENSEARCH_INDEX') || 'fb-tracker' }
  : undefined;
const imagePrefixes = (env('FLEET_IMAGE_PREFIX') || DEFAULT_IMAGE_PREFIX).split(',').map((p) => p.trim()).filter(Boolean);

const agent = new Agent({
  hostId,
  stateDir: env('FLEET_STATE_DIR') || '/state',
  client: new HttpFleetClient({
    baseUrl: env('FLEET_URL'),
    hostId,
    token: env('FLEET_HOST_TOKEN'),
    onFailure: (what, detail) => log.warn('erp call failed', { what, detail }),
  }),
  docker: new DockerCli(),
  workerEnv: { url: env('FLEET_URL'), hostId, ...(opensearch ? { opensearch } : {}) },
  version,
  staggerMs,
  log,
  imagePrefixes,
});

log.info('fleet-agent starting', { version, host_id: hostId, url: env('FLEET_URL'), interval_s: intervalMs / 1000, stagger_s: staggerMs / 1000, image_prefixes: imagePrefixes, opensearch: opensearch ?? 'off' });
if (staggerMs < DEFAULT_STAGGER_MS) log.warn('start stagger below the default; every start is a Facebook login', { stagger_s: staggerMs / 1000 });

let stopping = false;
let wake: (() => void) | null = null;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info('stopping', { signal });
    stopping = true;
    wake?.();
  });
}

while (!stopping) {
  try {
    const result = await agent.tick();
    log.info('tick', {
      online: result.online,
      observe_only: result.observe_only,
      count: result.desired.count,
      containers: result.containers.length,
      actions: result.actions.length,
      applied: result.applied.length,
      errors: result.errors.length ? result.errors : undefined,
      reported: result.reported,
    });
  } catch (e) {
    log.error('tick failed', { error: e instanceof Error ? e.message : String(e) });
  }
  if (stopping) break;
  await new Promise<void>((resolve) => {
    wake = resolve;
    setTimeout(resolve, intervalMs);
  });
  wake = null;
}
log.info('stopped');
