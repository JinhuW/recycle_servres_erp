// The real agent against the real daemon: a mock ERP hands out a harmless
// image and the agent starts, reports, scales down and holds observe-only.
// Opt in with FLEET_AGENT_LIVE_DOCKER=1; it builds an image and leaves nothing
// behind. Never point it at the worker image.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.js';
import { HttpFleetClient } from '../src/client.js';
import { DockerCli } from '../src/docker.js';
import { createLogger } from '../src/log.js';
import type { Desired } from '../src/types.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';

const run = promisify(execFile);
const live = process.env.FLEET_AGENT_LIVE_DOCKER === '1';
const HOST = `livetest-${process.pid}`;
const IMAGE = `fleet-agent-livetest:${process.pid}`;
const TOKEN = 'made-up-host-token';

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run('docker', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function labelled(): Promise<string[]> {
  return (await docker('ps', '-a', '--filter', `label=rs.fleet.host=${HOST}`, '--format', '{{.Names}}')).split('\n').filter(Boolean).sort();
}

function desired(over: Partial<Desired> = {}): Desired {
  return { authoritative: true, count: 2, image: IMAGE, version: 'test', vnc_ports: { [`${HOST}-1`]: 45901, [`${HOST}-2`]: 45902 }, roll: null, ...over };
}

describe.skipIf(!live)('live docker', () => {
  let server: MockServer;
  let stateDir: string;
  let agent: Agent;
  const lines: string[] = [];

  beforeAll(async () => {
    const build = execFile('docker', ['build', '-q', '-t', IMAGE, '-'], { maxBuffer: 1 << 20 });
    build.stdin!.end('FROM alpine:3\nCMD ["sleep", "3600"]\n');
    await new Promise<void>((resolve, reject) => build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`docker build exited ${code}`)))));
    server = await startMockServer(HOST, TOKEN, desired());
    stateDir = mkdtempSync(join(tmpdir(), 'fleet-agent-live-'));
    agent = new Agent({
      hostId: HOST,
      stateDir,
      client: new HttpFleetClient({ baseUrl: server.url, hostId: HOST, token: TOKEN }),
      docker: new DockerCli(),
      workerEnv: { url: server.url, hostId: HOST, token: TOKEN },
      version: 'test',
      staggerMs: 0,
      log: createLogger((l) => lines.push(l)),
    });
  });

  afterAll(async () => {
    const names = await labelled();
    if (names.length) await docker('rm', '-f', ...names);
    await docker('rmi', '-f', IMAGE).catch(() => undefined);
    await server?.close();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    process.stdout.write(lines.join(''));
  });

  it('starts count containers one per tick and reports them', async () => {
    const first = await agent.tick();
    expect(first.applied.map((a) => a.kind)).toEqual(['run']);
    expect(await labelled()).toEqual([`rs-fleet-${HOST}-1`]);
    const second = await agent.tick();
    expect(second.applied.map((a) => [a.kind, a.worker_id])).toEqual([['run', `${HOST}-2`]]);
    expect(await labelled()).toEqual([`rs-fleet-${HOST}-1`, `rs-fleet-${HOST}-2`]);
    const third = await agent.tick();
    expect(third.actions).toEqual([]);
    const report = server.reports.at(-1)!;
    expect(report.containers).toEqual([
      { worker_id: `${HOST}-1`, image: IMAGE, state: 'running', started_at: expect.any(String) },
      { worker_id: `${HOST}-2`, image: IMAGE, state: 'running', started_at: expect.any(String) },
    ]);
    const inspect = JSON.parse(await docker('inspect', `rs-fleet-${HOST}-2`))[0];
    expect(inspect.Config.Labels).toMatchObject({ 'rs.fleet.host': HOST, 'rs.fleet.worker': `${HOST}-2` });
    expect(inspect.Config.Env).toEqual(expect.arrayContaining([`RS_FLEET_URL=${server.url}`, `RS_FLEET_HOST_ID=${HOST}`, `RS_FLEET_HOST_TOKEN=${TOKEN}`, `RS_FLEET_WORKER_ID=${HOST}-2`, 'RS_VNC_PORT=45902']));
    expect(inspect.HostConfig.PortBindings['5900/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '45902' }]);
    expect(inspect.HostConfig.RestartPolicy.Name).toBe('no');
    expect(inspect.HostConfig.ShmSize).toBe(1073741824);
  });

  it('scales down when the count drops', async () => {
    server.desired = desired({ count: 1 });
    const result = await agent.tick();
    expect(result.applied.map((a) => [a.kind, a.worker_id])).toEqual([['remove', `${HOST}-2`]]);
    expect(await labelled()).toEqual([`rs-fleet-${HOST}-1`]);
    expect(server.reports.at(-1)!.containers.map((c) => c.worker_id)).toEqual([`${HOST}-1`]);
  });

  it('stays observe-only when not authoritative', async () => {
    server.desired = desired({ authoritative: false, count: 0 });
    const result = await agent.tick();
    expect(result.observe_only).toBe(true);
    expect(result.applied).toEqual([]);
    expect(await labelled()).toEqual([`rs-fleet-${HOST}-1`]);
    expect(server.reports.at(-1)!.containers.map((c) => c.worker_id)).toEqual([`${HOST}-1`]);
  });
});
