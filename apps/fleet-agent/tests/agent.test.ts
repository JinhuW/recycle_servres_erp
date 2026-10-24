// One tick end to end against the fake docker and a mock ERP. What these pin:
// the ERP and the workers never take each other down. Offline the host keeps
// what it runs; observe-only it runs nothing; a pull that fails leaves the old
// container in place.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.js';
import { HttpFleetClient } from '../src/client.js';
import { createLogger } from '../src/log.js';
import type { Desired } from '../src/types.js';
import { exited, FakeDocker, running } from './helpers/fake-docker.js';
import { startMockServer, type MockServer } from './helpers/mock-server.js';

const HOST = 'lab';
const TOKEN = 'made-up-host-token';

function desired(over: Partial<Desired> = {}): Desired {
  return { authoritative: true, count: 1, image: 'img:1', version: '0.14.0', vnc_ports: { 'lab-1': 5901, 'lab-2': 5902 }, roll: null, ...over };
}

let server: MockServer;
let stateDir: string;
let lines: string[];
let clock: number;

beforeEach(async () => {
  server = await startMockServer(HOST, TOKEN, desired());
  stateDir = mkdtempSync(join(tmpdir(), 'fleet-agent-'));
  lines = [];
  clock = Date.parse('2026-10-24T12:00:00Z');
});

afterEach(async () => {
  await server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

function agent(docker: FakeDocker, over: { staggerMs?: number; url?: string; token?: string } = {}) {
  const url = over.url ?? server.url;
  const token = over.token ?? TOKEN;
  return new Agent({
    hostId: HOST,
    stateDir,
    client: new HttpFleetClient({ baseUrl: url, hostId: HOST, token, timeoutMs: 2000 }),
    docker,
    workerEnv: { url, hostId: HOST, token },
    version: '1.335.0',
    now: () => clock,
    staggerMs: over.staggerMs ?? 0,
    log: createLogger((l) => lines.push(l)),
  });
}

const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('online', () => {
  it('starts the missing worker, caches the answer and reports what runs', async () => {
    const docker = new FakeDocker();
    const result = await agent(docker).tick();
    expect(result.online).toBe(true);
    expect(result.observe_only).toBe(false);
    expect(docker.commands).toEqual([
      ['ensure', 'img:1'],
      ['run', 'rs-fleet-lab-1', 'img:1', 5901, { url: server.url, hostId: HOST, token: TOKEN }],
    ]);
    expect(JSON.parse(readFileSync(join(stateDir, 'desired.json'), 'utf8'))).toEqual(desired());
    expect(server.requests.map((r) => [r.method, r.path, r.auth])).toEqual([
      ['GET', '/api/fleet/hosts/lab/desired', `Bearer ${TOKEN}`],
      ['POST', '/api/fleet/hosts/lab/report', `Bearer ${TOKEN}`],
    ]);
    expect(server.reports).toEqual([
      { version: '1.335.0', containers: [{ worker_id: 'lab-1', image: 'img:1', state: 'running', started_at: expect.any(String) }] },
    ]);
    expect(logged().find((l) => l.msg === 'run')).toMatchObject({ level: 'info', worker_id: 'lab-1', reason: 'missing' });
    expect(lines.join('')).not.toContain(TOKEN);
  });

  it('scales down when the count drops, highest first', async () => {
    const docker = new FakeDocker([running('lab-1'), running('lab-2'), running('lab-3')]);
    server.desired = desired({ count: 1 });
    const result = await agent(docker).tick();
    expect(docker.commands).toEqual([['stop+rm', 'rs-fleet-lab-3'], ['stop+rm', 'rs-fleet-lab-2']]);
    expect(result.containers.map((c) => c.worker_id)).toEqual(['lab-1']);
    expect(server.reports[0].containers.map((c) => c.worker_id)).toEqual(['lab-1']);
  });

  it('staggers starts across ticks and remembers the last one on disk', async () => {
    const docker = new FakeDocker();
    server.desired = desired({ count: 2 });
    const a = agent(docker, { staggerMs: 180_000 });
    await a.tick();
    expect(docker.commands.filter((c) => c[0] === 'run')).toHaveLength(1);
    clock += 60_000;
    await a.tick();
    expect(docker.commands.filter((c) => c[0] === 'run')).toHaveLength(1);
    clock += 120_000;
    // A fresh agent (as after its own restart) reads the last start back.
    const again = agent(docker, { staggerMs: 180_000 });
    clock -= 1000;
    await again.tick();
    expect(docker.commands.filter((c) => c[0] === 'run')).toHaveLength(1);
    clock += 1000;
    await again.tick();
    expect(docker.commands.filter((c) => c[0] === 'run').map((c) => c[1])).toEqual(['rs-fleet-lab-1', 'rs-fleet-lab-2']);
  });

  it('replaces a rolled worker after the new image is there', async () => {
    const docker = new FakeDocker([running('lab-1', 'img:1')]);
    server.desired = desired({ image: 'img:2', roll: { replace: 'lab-1' } });
    await agent(docker).tick();
    expect(docker.commands).toEqual([
      ['ensure', 'img:2'],
      ['stop+rm', 'rs-fleet-lab-1'],
      ['run', 'rs-fleet-lab-1', 'img:2', 5901, expect.anything()],
    ]);
    expect(server.reports[0].containers[0].image).toBe('img:2');
  });

  it('leaves the old worker running when the pull fails', async () => {
    const docker = new FakeDocker([running('lab-1', 'img:1')], ['img:1']);
    server.desired = desired({ image: 'img:3', roll: { replace: 'lab-1' } });
    const result = await agent(docker).tick();
    expect(docker.commands).toEqual([['ensure', 'img:3']]);
    expect(docker.containers.has('rs-fleet-lab-1')).toBe(true);
    expect(result.errors[0]).toMatch(/lab-1: image img:3 is not available/);
    expect(logged().find((l) => l.msg === 'failed')).toMatchObject({ level: 'error', worker_id: 'lab-1' });
  });

  it('counts crash restarts and leaves a looping worker stopped', async () => {
    const docker = new FakeDocker([running('lab-1'), exited('lab-2', 1, '2026-10-24T11:00:00Z')]);
    server.desired = desired({ count: 2 });
    const a = agent(docker);
    for (let i = 0; i < 5; i++) {
      await a.tick();
      expect(docker.commands.filter((c) => c[0] === 'start')).toHaveLength(i + 1);
      // The worker dies again two minutes later.
      clock += 120_000;
      docker.containers.set('rs-fleet-lab-2', exited('lab-2', 1, new Date(clock - 61_000).toISOString()));
    }
    const result = await a.tick();
    expect(result.actions).toEqual([]);
    expect(docker.commands.filter((c) => c[0] === 'start')).toHaveLength(5);
    expect(logged().filter((l) => l.msg === 'note').map((l) => l.note)).toContainEqual(expect.stringMatching(/lab-2: 5 restarts in 30 min \(last exit 1\); left stopped/));
    const memory = JSON.parse(readFileSync(join(stateDir, 'memory.json'), 'utf8'));
    expect(memory.restarts['lab-2']).toHaveLength(5);
    expect(server.reports.at(-1)!.containers[1]).toMatchObject({ worker_id: 'lab-2', state: 'exited' });
  });

  it('refuses to proceed when its token is wrong, and runs nothing', async () => {
    const docker = new FakeDocker();
    const result = await agent(docker, { token: 'wrong' }).tick();
    expect(result.online).toBe(false);
    expect(docker.commands).toEqual([]);
    expect(server.reports).toEqual([]);
  });
});

describe('observe-only', () => {
  it('plans, logs what it would do, runs nothing, still reports', async () => {
    const docker = new FakeDocker([running('lab-5')]);
    server.desired = desired({ authoritative: false, count: 2 });
    const result = await agent(docker).tick();
    expect(result.observe_only).toBe(true);
    expect(docker.commands).toEqual([]);
    expect(server.reports[0].containers.map((c) => c.worker_id)).toEqual(['lab-5']);
    expect(logged().filter((l) => l.msg === 'held')).toEqual([]);
    expect(logged().find((l) => l.msg === 'note')).toMatchObject({ note: 'not authoritative: observing only' });
  });
});

describe('offline', () => {
  it('uses the cached desired state, says so once, and restarts only', async () => {
    const docker = new FakeDocker([exited('lab-1', 75, '2026-10-24T11:00:00Z')]);
    server.desired = desired({ count: 2 });
    const a = agent(docker);
    await a.tick();
    expect(docker.commands).toEqual([['start', 'rs-fleet-lab-1']]);
    docker.commands = [];
    server.desired = 'error';
    clock += 60_000;
    // While the ERP is away a stray extra appears and lab-1 exits again.
    docker.containers.set('rs-fleet-lab-3', running('lab-3'));
    docker.containers.set('rs-fleet-lab-1', exited('lab-1', 75, new Date(clock - 61_000).toISOString()));
    await a.tick();
    expect(docker.commands).toEqual([['start', 'rs-fleet-lab-1']]); // no run of lab-2, no removal of lab-3
    docker.commands = [];
    await a.tick();
    expect(docker.commands).toEqual([]);
    expect(logged().filter((l) => l.msg === 'desired state unavailable')).toHaveLength(1);
    expect(server.reports).toHaveLength(1); // nobody to report to
    server.desired = desired({ count: 2 });
    clock += 60_000;
    const back = await a.tick();
    expect(back.online).toBe(true);
    expect(logged().filter((l) => l.msg === 'back online')).toHaveLength(1);
    expect(docker.commands).toEqual([['stop+rm', 'rs-fleet-lab-3'], ['ensure', 'img:1'], ['run', 'rs-fleet-lab-2', 'img:1', 5902, expect.anything()]]);
  });

  it('with nothing cached touches nothing', async () => {
    const docker = new FakeDocker([exited('lab-1', 75, '2026-10-24T11:00:00Z')]);
    server.desired = 'garbage';
    const result = await agent(docker).tick();
    expect(result.online).toBe(false);
    expect(result.observe_only).toBe(true);
    expect(docker.commands).toEqual([]);
  });

  it('a daemon that does not answer means no plan and no report', async () => {
    const docker = new FakeDocker();
    docker.reachable = false;
    const result = await agent(docker).tick();
    expect(result.actions).toEqual([]);
    expect(result.errors).toEqual(['docker unreachable']);
    expect(server.reports).toEqual([]);
  });
});
