// One tick end to end against the fake docker and a mock ERP. What these pin:
// the ERP and the workers never take each other down. Offline the host keeps
// what it runs; observe-only it runs nothing; a pull that fails leaves the old
// container in place.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.js';
import { HttpFleetClient } from '../src/client.js';
import { runEnv } from '../src/docker.js';
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

function agent(docker: FakeDocker, over: { staggerMs?: number; url?: string; token?: string; imagePrefixes?: string[]; keepaliveMs?: number; random?: () => number } = {}) {
  const url = over.url ?? server.url;
  const token = over.token ?? TOKEN;
  docker.now = () => new Date(clock).toISOString();
  return new Agent({
    hostId: HOST,
    stateDir,
    client: new HttpFleetClient({ baseUrl: url, hostId: HOST, token, timeoutMs: 2000 }),
    docker,
    workerEnv: { url, hostId: HOST },
    version: '1.335.0',
    now: () => clock,
    staggerMs: over.staggerMs ?? 0,
    log: createLogger((l) => lines.push(l)),
    ...(over.imagePrefixes ? { imagePrefixes: over.imagePrefixes } : {}),
    ...(over.keepaliveMs ? { keepaliveMs: over.keepaliveMs } : {}),
    ...(over.random ? { random: over.random } : {}),
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
      ['run', 'rs-fleet-lab-1', 'img:1', 5901, { url: server.url, hostId: HOST }],
    ]);
    expect(docker.tickets).toEqual(server.tickets);
    expect(server.ticketRequests).toEqual([{ worker_id: 'lab-1' }]);
    expect(JSON.parse(readFileSync(join(stateDir, 'desired.json'), 'utf8'))).toEqual(desired());
    expect(server.requests.map((r) => [r.method, r.path, r.auth])).toEqual([
      ['GET', '/api/fleet/hosts/lab/desired', `Bearer ${TOKEN}`],
      ['POST', '/api/fleet/hosts/lab/tickets', `Bearer ${TOKEN}`],
      ['POST', '/api/fleet/hosts/lab/report', `Bearer ${TOKEN}`],
    ]);
    expect(server.reports).toEqual([
      {
        version: '1.335.0',
        containers: [{ worker_id: 'lab-1', image: 'img:1', state: 'running', started_at: expect.any(String), exit_code: null }],
        agent: { instance_id: expect.stringMatching(/^[0-9a-f-]{36}$/), daemon_id: 'fake-daemon' },
      },
    ]);
    expect(server.requests.every((r) => r.instance === server.reports[0].agent!.instance_id)).toBe(true);
    expect(logged().find((l) => l.msg === 'run')).toMatchObject({ level: 'info', worker_id: 'lab-1', reason: 'missing' });
    expect(lines.join('')).not.toContain(TOKEN);
  });

  it('keeps the workers above a lowered count, and says so', async () => {
    const docker = new FakeDocker([running('lab-1'), running('lab-2'), running('lab-3')]);
    server.desired = desired({ count: 1 });
    const result = await agent(docker).tick();
    expect(docker.commands).toEqual([]);
    expect(result.containers.map((c) => c.worker_id)).toEqual(['lab-1', 'lab-2', 'lab-3']);
    expect(server.reports[0].containers.map((c) => c.worker_id)).toEqual(['lab-1', 'lab-2', 'lab-3']);
    expect(logged().filter((l) => l.msg === 'note').map((l) => l.note)).toEqual(['lab-2: beyond count 1; left running', 'lab-3: beyond count 1; left running']);
  });

  it('removes a stopped worker above the count on an old image, and stamps no start', async () => {
    const docker = new FakeDocker([running('lab-1', 'img:2'), exited('lab-3', 75, '2026-10-23T12:00:00Z', 'img:1')]);
    server.desired = desired({ image: 'img:2' });
    const result = await agent(docker).tick();
    expect(docker.commands).toEqual([['rm', 'rs-fleet-lab-3']]);
    expect(server.reports[0].containers.map((c) => c.worker_id)).toEqual(['lab-1']);
    expect(result.applied.map((a) => a.kind)).toEqual(['remove']);
    // No start stamped now: what is kept is the newest start Docker showed (lab-1's).
    expect(JSON.parse(readFileSync(join(stateDir, 'memory.json'), 'utf8')).last_start_at).toBe(Date.parse('2026-10-24T10:00:00Z'));
  });

  it('leaves an extra running when a person starts it between observe and remove', async () => {
    const docker = new FakeDocker([running('lab-1', 'img:2'), exited('lab-3', 75, '2026-10-23T12:00:00Z', 'img:1')]);
    const observe = docker.observe.bind(docker);
    docker.observe = async (hostId) => {
      const seen = await observe(hostId);
      const c = docker.containers.get('rs-fleet-lab-3')!;
      docker.containers.set(c.name, { ...c, running: true, status: 'running', exit_code: null });
      return seen;
    };
    server.desired = desired({ image: 'img:2' });
    await agent(docker).tick();
    expect(docker.commands).toEqual([['rm', 'rs-fleet-lab-3']]);
    expect(docker.containers.get('rs-fleet-lab-3')?.running).toBe(true);
  });

  it('keeps the stagger of a start made by hand on an extra it then removes', async () => {
    const extra = { ...exited('lab-3', 1, new Date(clock - 20_000).toISOString(), 'img:1'), started_at: new Date(clock - 40_000).toISOString() };
    const docker = new FakeDocker([extra]);
    server.desired = desired({ image: 'img:2' });
    const a = agent(docker, { staggerMs: 180_000 });
    expect((await a.tick()).applied.map((x) => [x.kind, x.worker_id])).toEqual([['remove', 'lab-3']]);
    clock += 30_000;
    expect((await a.tick()).actions).toEqual([]);
    clock += 120_000;
    expect((await a.tick()).actions.map((x) => [x.kind, x.worker_id])).toEqual([['run', 'lab-1']]);
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
    expect(server.reports.at(-1)!.containers[1]).toMatchObject({ worker_id: 'lab-2', state: 'crash_limit', hold: 'crash_limit', exit_code: 1 });
    // The window ageing out does not start the loop again, nor does an agent restart.
    clock += 60 * 60_000;
    expect((await a.tick()).actions).toEqual([]);
    expect((await agent(docker).tick()).actions).toEqual([]);
    expect(docker.commands.filter((c) => c[0] === 'start')).toHaveLength(5);
    // A person removes it: the agent runs a fresh one on its turn.
    docker.containers.delete('rs-fleet-lab-2');
    const fresh = await agent(docker).tick();
    expect(fresh.actions.map((x) => [x.kind, x.worker_id])).toEqual([['run', 'lab-2']]);
  });

  it('leaves a worker that exited 78 stopped and reports it as needing an operator', async () => {
    const docker = new FakeDocker([running('lab-1'), exited('lab-2', 78, '2026-10-24T09:00:00Z')]);
    server.desired = desired({ count: 2 });
    const a = agent(docker);
    for (let i = 0; i < 3; i++) {
      const result = await a.tick();
      expect(result.actions).toEqual([]);
      clock += 30 * 60_000;
    }
    expect(docker.commands).toEqual([]);
    expect(server.reports.at(-1)!.containers[1]).toMatchObject({ worker_id: 'lab-2', state: 'operator_needed' });
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
    expect(docker.commands).toEqual([['start', 'rs-fleet-lab-1']]); // no run of lab-2
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
    expect(docker.commands).toEqual([['ensure', 'img:1'], ['run', 'rs-fleet-lab-2', 'img:1', 5902, expect.anything()]]);
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

describe('the stagger survives what goes wrong around a start', () => {
  it('counts a start whose answer was lost: a timed-out run that still started is not followed by another', async () => {
    const docker = new FakeDocker();
    server.desired = desired({ count: 2 });
    docker.failNext.run = { error: 'docker run: signal SIGTERM (timed out)', effect: true };
    const a = agent(docker, { staggerMs: 180_000 });
    const first = await a.tick();
    expect(first.errors).toEqual([expect.stringMatching(/lab-1: docker run/)]);
    clock += 30_000;
    expect((await a.tick()).actions).toEqual([]);
    expect(docker.commands.filter((c) => c[0] === 'run')).toHaveLength(1);
  });

  it('measures from the newest container start when /state is lost', async () => {
    const docker = new FakeDocker([running('lab-1', 'img:1', new Date(clock - 60_000).toISOString())]);
    server.desired = desired({ count: 2 });
    expect((await agent(docker, { staggerMs: 180_000 }).tick()).actions).toEqual([]);
    clock += 120_000;
    expect((await agent(docker, { staggerMs: 180_000 }).tick()).actions.map((x) => x.worker_id)).toEqual(['lab-2']);
  });

  it.skipIf(process.getuid?.() === 0)('makes no start it cannot write down', async () => {
    const docker = new FakeDocker();
    const a = agent(docker);
    chmodSync(stateDir, 0o500);
    try {
      const result = await a.tick();
      expect(result.applied).toEqual([]);
      expect(result.errors).toContainEqual('lab-1: start withheld: cannot record it under /state');
      expect(docker.commands.filter((c) => c[0] === 'run')).toEqual([]);
    } finally {
      chmodSync(stateDir, 0o700);
    }
  });
});

describe('workers a person stopped', () => {
  it('leaves an exit 0 that happened while the agent ran, and reports it', async () => {
    const docker = new FakeDocker([running('lab-1')]);
    const a = agent(docker);
    clock += 60_000;
    docker.containers.set('rs-fleet-lab-1', exited('lab-1', 0, new Date(clock - 1000).toISOString()));
    clock += 10 * 60_000;
    expect((await a.tick()).actions).toEqual([]);
    expect(server.reports.at(-1)!.containers[0]).toMatchObject({ state: 'operator_stopped', hold: 'operator_stopped', exit_code: 0 });
    // Still held after an agent restart: the hold is remembered for that container.
    expect((await agent(docker).tick()).actions).toEqual([]);
  });

  it('remembers a stop by hand above the count, so a restarted agent does not remove it', async () => {
    const docker = new FakeDocker([running('lab-1', 'img:2'), running('lab-3', 'img:1')]);
    server.desired = desired({ image: 'img:2' });
    const a = agent(docker);
    clock += 60_000;
    docker.containers.set('rs-fleet-lab-3', exited('lab-3', 0, new Date(clock - 1000).toISOString(), 'img:1'));
    clock += 10 * 60_000;
    expect((await a.tick()).actions).toEqual([]);
    expect((await agent(docker).tick()).actions).toEqual([]);
    expect(docker.commands).toEqual([]);
  });

  it('restarts an exit 0 from before the agent started: the host went down, not a person', async () => {
    const docker = new FakeDocker([exited('lab-1', 0, new Date(clock - 5 * 60_000).toISOString())]);
    expect((await agent(docker).tick()).actions.map((x) => x.kind)).toEqual(['start']);
  });
});

describe('confirmed-stop handoff', () => {
  const lease = { 'lab-1': { account_no: 7, epoch: 3 } };

  it('replaces a rolled worker through a confirmed stop and hands the epoch on', async () => {
    const docker = new FakeDocker([running('lab-1', 'img:1')]);
    server.desired = desired({ image: 'img:2', roll: { replace: 'lab-1' }, leases: lease });
    const result = await agent(docker).tick();
    expect(result.errors).toEqual([]);
    expect(server.stopped).toEqual([expect.objectContaining({ worker_id: 'lab-1', account_no: 7, epoch: 3, restart: true, agent_instance: expect.any(String), daemon_id: 'fake-daemon' })]);
    expect(docker.handoffs).toEqual([3]);
    // The ticket is bound to the handoff the replacement claims with.
    expect(server.ticketRequests).toEqual([{ worker_id: 'lab-1', handoff_epoch: 3 }]);
    expect(docker.tickets).toEqual(server.tickets);
    expect(JSON.parse(readFileSync(join(stateDir, 'memory.json'), 'utf8')).pending).toEqual({});
  });

  it('retries a lost confirmation and runs only after it, once', async () => {
    const docker = new FakeDocker([running('lab-1', 'img:1')]);
    server.desired = desired({ image: 'img:2', roll: { replace: 'lab-1' }, leases: lease });
    server.stoppedAnswer = 500;
    const first = await agent(docker).tick();
    expect(first.errors).toEqual(['lab-1: could not replace rs-fleet-lab-1: stop confirmation not accepted']);
    expect(docker.commands.filter((c) => c[0] === 'run')).toEqual([]);
    // Still unconfirmed, and the agent restarts: the identity comes back from /state.
    clock += 30_000;
    expect((await agent(docker).tick()).errors).toEqual(['lab-1: stop confirmation not accepted']);
    server.stoppedAnswer = 200;
    clock += 30_000;
    expect((await agent(docker).tick()).errors).toEqual([]);
    expect(docker.commands.filter((c) => c[0] === 'run')).toHaveLength(1);
    expect(docker.commands.filter((c) => c[0] === 'stop+rm')).toHaveLength(1);
    expect(docker.handoffs).toEqual([3]);
    expect(server.stopped.map((s) => [s.epoch, s.restart])).toEqual([[3, true], [3, true], [3, true]]);
  });

  it('runs without the reservation when the ERP calls the stop stale', async () => {
    const docker = new FakeDocker([running('lab-1', 'img:1')]);
    server.desired = desired({ image: 'img:2', roll: { replace: 'lab-1' }, leases: lease });
    server.stoppedAnswer = 409;
    expect((await agent(docker).tick()).errors).toEqual([]);
    expect(docker.handoffs).toEqual([undefined]);
    expect(server.ticketRequests).toEqual([{ worker_id: 'lab-1' }]);
  });

  it('leaves an extra and its account alone', async () => {
    const docker = new FakeDocker([running('lab-1'), running('lab-2')]);
    server.desired = desired({ count: 1, leases: { 'lab-2': { account_no: 9, epoch: 4 } } });
    expect((await agent(docker).tick()).errors).toEqual([]);
    expect(server.stopped).toEqual([]);
    expect(docker.commands.filter((c) => c[0] === 'stop+rm')).toEqual([]);
  });

  it('runs again an extra stopped for its replacement when the first run failed', async () => {
    const docker = new FakeDocker([running('lab-1', 'img:2'), running('lab-3', 'img:1')]);
    server.desired = desired({ count: 1, image: 'img:2', roll: { replace: 'lab-3' }, vnc_ports: { 'lab-1': 5901, 'lab-3': 5903 }, leases: { 'lab-3': { account_no: 9, epoch: 4 } } });
    server.ticketAnswer = 404;
    const a = agent(docker);
    await a.tick();
    expect(docker.commands.map((c) => c[0])).toEqual(['ensure', 'stop+rm']);
    clock += 60_000;
    await a.tick();
    // The stop is not turned into a removal: the account stays reserved.
    expect(server.stopped.filter((s) => s.restart === false)).toEqual([]);
    server.ticketAnswer = 200;
    clock += 60_000;
    docker.commands = [];
    expect((await a.tick()).errors).toEqual([]);
    expect(docker.commands.map((c) => c[0])).toContain('run');
    expect(docker.handoffs).toEqual([4]);
  });

  it('releases a waiting reservation when the host turns observe-only', async () => {
    const docker = new FakeDocker();
    writeFileSync(join(stateDir, 'memory.json'), JSON.stringify({ last_start_at: null, restarts: {}, pending: { 'lab-1': { account_no: 7, epoch: 3, restart: true, confirmed: true } } }));
    server.desired = desired({ authoritative: false, count: 0 });
    await agent(docker).tick();
    expect(server.stopped).toEqual([expect.objectContaining({ worker_id: 'lab-1', restart: false })]);
    expect(docker.commands).toEqual([]);
  });

  it('a spent handoff does not wedge the worker: an exited replacement is stopped and run again', async () => {
    // The replacement ran, but the agent died before it forgot the handoff;
    // then the replacement exited.
    writeFileSync(join(stateDir, 'memory.json'), JSON.stringify({ last_start_at: null, restarts: {}, pending: { 'lab-1': { account_no: 7, epoch: 3, restart: true, confirmed: true } } }));
    const docker = new FakeDocker([exited('lab-1', 75, new Date(clock - 120_000).toISOString())]);
    server.desired = desired({ leases: { 'lab-1': { account_no: 7, epoch: 5 } } });
    const result = await agent(docker).tick();
    expect(result.errors).toEqual([]);
    expect(docker.commands.map((c) => c[0])).toEqual(['ensure', 'stop+rm', 'run']);
    // The fresh identity from the lease, not the spent one.
    expect(server.stopped.map((s) => s.epoch)).toEqual([5]);
    expect(docker.handoffs).toEqual([5]);
  });

  it('offline, a worker started with a handoff waits instead of claiming with a spent reservation', async () => {
    const docker = new FakeDocker([{ ...exited('lab-1', 75, new Date(clock - 120_000).toISOString()), handoff: true }]);
    server.desired = desired({ leases: {} });
    await agent(docker).tick(); // caches the desired state (and recreates online)
    docker.commands = [];
    docker.containers.set('rs-fleet-lab-1', { ...exited('lab-1', 75, new Date(clock - 120_000).toISOString()), handoff: true });
    server.desired = 'error';
    clock += 60_000;
    expect((await agent(docker).tick()).actions).toEqual([]);
    expect(docker.commands).toEqual([]);
  });
});

describe('claim tickets', () => {
  it('each run gets its own fresh ticket, and the host token reaches no container', async () => {
    const docker = new FakeDocker();
    server.desired = desired({ count: 2 });
    await agent(docker).tick();
    await agent(docker).tick();
    expect(server.tickets).toHaveLength(2);
    expect(new Set(server.tickets).size).toBe(2);
    expect(docker.tickets).toEqual(server.tickets);
    expect(server.ticketRequests).toEqual([{ worker_id: 'lab-1' }, { worker_id: 'lab-2' }]);
    for (const c of docker.commands.filter((x) => x[0] === 'run')) {
      expect(JSON.stringify(c)).not.toContain(TOKEN);
    }
    const env = runEnv({ worker_id: 'lab-1', image: 'img:1', port: 5901, ticket: docker.tickets[0] }, { url: server.url, hostId: HOST });
    expect(Object.values(env)).not.toContain(TOKEN);
    expect(env.RS_FLEET_CLAIM_TICKET).toBe(docker.tickets[0]);
  });

  it('without a ticket nothing runs and the stagger is not spent', async () => {
    const docker = new FakeDocker();
    server.ticketAnswer = 500;
    const a = agent(docker, { staggerMs: 180_000 });
    const first = await a.tick();
    expect(first.errors).toEqual(['lab-1: no claim ticket from the ERP; not started']);
    expect(docker.commands).toEqual([['ensure', 'img:1']]);
    server.ticketAnswer = 200;
    clock += 30_000;
    await a.tick();
    expect(docker.commands.filter((c) => c[0] === 'run')).toHaveLength(1);
  });

  it('an older ERP without the route (404) starts nothing rather than hand out the host token', async () => {
    const docker = new FakeDocker();
    server.ticketAnswer = 404;
    expect((await agent(docker).tick()).errors).toEqual(['lab-1: no claim ticket from the ERP; not started']);
    expect(docker.commands.filter((c) => c[0] === 'run')).toEqual([]);
  });
});

describe('when it must not act', () => {
  it('a refused desired state (deleted host, revoked token) is observe-only even with a cache', async () => {
    const docker = new FakeDocker([exited('lab-1', 75, '2026-10-24T11:00:00Z')]);
    await agent(docker).tick();
    docker.commands = [];
    docker.containers.set('rs-fleet-lab-1', exited('lab-1', 75, new Date(clock - 120_000).toISOString()));
    server.desired = null; // 404
    const result = await agent(docker).tick();
    expect(result.refused).toBe(true);
    expect(result.observe_only).toBe(true);
    expect(docker.commands).toEqual([]);
  });

  it('another agent for this host on the daemon makes it observe-only and says so in the report', async () => {
    const docker = new FakeDocker();
    docker.agents = ['rs-fleet-agent-old'];
    const result = await agent(docker).tick();
    expect(result.observe_only).toBe(true);
    expect(docker.commands).toEqual([]);
    expect(server.reports[0].agent).toMatchObject({ conflict: ['rs-fleet-agent-old'] });
    expect(logged().find((l) => String(l.msg).startsWith('another fleet agent'))).toMatchObject({ level: 'error' });
  });

  it('creates nothing on an image outside FLEET_IMAGE_PREFIX', async () => {
    const docker = new FakeDocker();
    server.desired = desired({ image: 'docker.io/evil/miner:1' });
    const result = await agent(docker, { imagePrefixes: ['ghcr.io/jinhuw/aimm-recycle'] }).tick();
    expect(result.actions).toEqual([]);
    expect(docker.commands).toEqual([]);
  });

  it('logs a standing note once, not every tick', async () => {
    const docker = new FakeDocker([running('lab-1'), exited('lab-2', 78, '2026-10-24T09:00:00Z')]);
    server.desired = desired({ count: 2 });
    const a = agent(docker);
    await a.tick();
    await a.tick();
    expect(logged().filter((l) => l.msg === 'note' && String(l.note).startsWith('lab-2: exit 78'))).toHaveLength(1);
  });
});

it('keeps reporting while a long action runs', async () => {
  const docker = new FakeDocker();
  const slow = docker.ensureImage.bind(docker);
  docker.ensureImage = async (image) => {
    await new Promise((r) => setTimeout(r, 120));
    return slow(image);
  };
  await agent(docker, { keepaliveMs: 30 }).tick();
  expect(server.reports.length).toBeGreaterThanOrEqual(3);
});

describe('licence outage', () => {
  const MIN = 60_000;
  const memory = () => JSON.parse(readFileSync(join(stateDir, 'memory.json'), 'utf8')) as Record<string, any>;
  const remember = (m: Record<string, unknown>) => writeFileSync(join(stateDir, 'memory.json'), JSON.stringify(m));
  const lastReport = () => server.reports.at(-1)!.containers[0];
  const starts = (docker: FakeDocker) => docker.commands.filter((c) => c[0] === 'start' || c[0] === 'run').length;
  /** lab-1 exits 74 right now, after a run far too short to count as recovery. */
  const fail = (docker: FakeDocker, id = 'lab-1') => {
    const c = { ...exited(id, 74, new Date(clock).toISOString()), started_at: new Date(clock - 30_000).toISOString() };
    docker.containers.set(`rs-fleet-${id}`, c);
    return c;
  };
  const SEQUENCE = [5, 10, 20, 40, 60, 60, 60, 60];

  it('walks the backoff, starts once per wait, then holds and reports it', async () => {
    const docker = new FakeDocker();
    const a = agent(docker, { random: () => 0 });
    for (const [i, wait] of SEQUENCE.entries()) {
      fail(docker);
      docker.commands = [];
      await a.tick();
      expect(lastReport()).toMatchObject({ state: 'exited', exit_code: 74, outage_attempts: i });
      clock += wait * MIN - 1000;
      await a.tick();
      expect(starts(docker)).toBe(0);
      clock += 1000;
      await a.tick();
      expect(starts(docker)).toBe(1);
    }
    expect(memory().restarts).toEqual({});
    expect(memory().soft_restarts).toEqual({});
    const last = fail(docker);
    docker.commands = [];
    await a.tick();
    expect(starts(docker)).toBe(0);
    expect(memory().held).toEqual({ 'lab-1': { container: last.id, reason: 'license_outage' } });
    expect(lastReport()).toMatchObject({ state: 'license_outage', hold: 'license_outage', exit_code: 74, outage_attempts: 8 });
    clock += 24 * 60 * MIN;
    await a.tick();
    expect(starts(docker)).toBe(0);
  });

  it('an agent restart at every tick changes neither the count nor the hold', async () => {
    const docker = new FakeDocker();
    for (const wait of SEQUENCE) {
      fail(docker);
      docker.commands = [];
      await agent(docker, { random: () => 0 }).tick();
      clock += wait * MIN - 1000;
      await agent(docker, { random: () => 0 }).tick();
      expect(starts(docker)).toBe(0);
      clock += 1000;
      await agent(docker, { random: () => 0 }).tick();
      expect(starts(docker)).toBe(1);
    }
    fail(docker);
    docker.commands = [];
    await agent(docker).tick();
    await agent(docker).tick();
    expect(starts(docker)).toBe(0);
    expect(lastReport()).toMatchObject({ hold: 'license_outage', outage_attempts: 8 });
  });

  it('draws the jitter once per wait: neither a later tick nor an agent restart draws again', async () => {
    let draws = 0;
    const docker = new FakeDocker();
    fail(docker);
    const a = agent(docker, { random: () => { draws++; return 0.5; } });
    await a.tick();
    clock += MIN;
    await a.tick();
    expect(draws).toBe(1);
    // 5 min + 12.5%; a fresh draw of 0 here would have started it at 5 min.
    clock += 4 * MIN;
    await agent(docker, { random: () => 0 }).tick();
    expect(starts(docker)).toBe(0);
    clock += 0.625 * MIN;
    await agent(docker, { random: () => 0 }).tick();
    expect(starts(docker)).toBe(1);
  });

  it('a long healthy run clears the count, so the next outage starts at 5 min', async () => {
    remember({ license_outage: { 'lab-1': { attempts: 7, jitter: 0 } } });
    const docker = new FakeDocker([running('lab-1', 'img:1', new Date(clock - 59 * MIN).toISOString())]);
    const a = agent(docker, { random: () => 0 });
    await a.tick();
    expect(memory().license_outage).toEqual({ 'lab-1': { attempts: 7, jitter: 0 } });
    expect(lastReport()).toMatchObject({ outage_attempts: 7 });
    clock += 2 * MIN;
    await a.tick();
    expect(memory().license_outage).toEqual({});
    expect(lastReport()).not.toHaveProperty('outage_attempts');
    fail(docker);
    await a.tick();
    clock += 5 * MIN;
    await a.tick();
    expect(starts(docker)).toBe(1);
  });

  it('a long run the agent never saw running also counts: it was down meanwhile', async () => {
    remember({ license_outage: { 'lab-1': { attempts: 8, jitter: 0 } } });
    const docker = new FakeDocker();
    docker.containers.set('rs-fleet-lab-1', { ...exited('lab-1', 74, new Date(clock).toISOString()), started_at: new Date(clock - 120 * MIN).toISOString() });
    await agent(docker, { random: () => 0 }).tick();
    expect(memory().held).toEqual({});
    expect(memory().license_outage).toEqual({ 'lab-1': { attempts: 0, jitter: 0 } });
  });

  /** Exits 74 now, after a run long enough to count as recovery. */
  const failAfterLongRun = (docker: FakeDocker) => docker.containers.set('rs-fleet-lab-1', { ...exited('lab-1', 74, new Date(clock).toISOString()), started_at: new Date(clock - 120 * MIN).toISOString() });

  it('a long-running worker that exits 74 keeps its first draw until the retry, and idle ticks write nothing', async () => {
    const path = join(stateDir, 'memory.json');
    const draws = [0.8, 0.1, 0.2, 0.3, 0.4, 0.5];
    const random = () => draws.shift()!;
    const docker = new FakeDocker();
    failAfterLongRun(docker);
    const a = agent(docker, { random });
    await a.tick();
    expect(memory().license_outage).toEqual({ 'lab-1': { attempts: 0, jitter: 0.8 } });
    writeFileSync(path, 'untouched');
    for (const step of [1, 1, 3, 0.9]) { // to 5.9 min of the 6 the first draw gives
      clock += step * MIN;
      await a.tick();
      expect(starts(docker)).toBe(0);
    }
    expect(draws).toHaveLength(5);
    expect(readFileSync(path, 'utf8')).toBe('untouched');
    clock += 0.1 * MIN;
    await a.tick();
    expect(starts(docker)).toBe(1);
    expect(memory().license_outage).toEqual({ 'lab-1': { attempts: 1, jitter: 0.1 } });
  });

  it('a long run that ends in another 74 is a new outage: one fresh draw, attempts back to 0', async () => {
    remember({ license_outage: { 'lab-1': { attempts: 3, jitter: 0.9 } } });
    const draws = [0.2, 0.7, 0.7];
    const docker = new FakeDocker();
    failAfterLongRun(docker);
    const a = agent(docker, { random: () => draws.shift()! });
    await a.tick();
    expect(memory().license_outage).toEqual({ 'lab-1': { attempts: 0, jitter: 0.2 } });
    clock += 5.2 * MIN;
    await a.tick();
    expect(starts(docker)).toBe(0);
    expect(draws).toHaveLength(2);
    clock += 0.05 * MIN; // 5.25 min: 5 plus 25% of the 0.2 draw
    await a.tick();
    expect(starts(docker)).toBe(1);
  });

  it('a long run that ends in any other exit still clears the record', async () => {
    remember({ license_outage: { 'lab-1': { attempts: 0, jitter: 0.5 } } });
    const docker = new FakeDocker();
    docker.containers.set('rs-fleet-lab-1', { ...exited('lab-1', 75, new Date(clock).toISOString()), started_at: new Date(clock - 120 * MIN).toISOString() });
    await agent(docker).tick();
    expect(memory().license_outage).toEqual({});
  });

  it('a short recovery does not clear the count', async () => {
    remember({ license_outage: { 'lab-1': { attempts: 3, jitter: 0 } } });
    const docker = new FakeDocker([running('lab-1', 'img:1', new Date(clock - 10 * MIN).toISOString())]);
    await agent(docker).tick();
    expect(lastReport()).toMatchObject({ outage_attempts: 3 });
  });

  it('a person bringing a held worker back gets a whole new set of retries', async () => {
    const docker = new FakeDocker();
    const c = fail(docker);
    remember({ license_outage: { 'lab-1': { attempts: 8, jitter: 0 } }, held: { 'lab-1': { container: c.id, reason: 'license_outage' } } });
    const a = agent(docker, { random: () => 0 });
    await a.tick();
    expect(starts(docker)).toBe(0);
    docker.containers.delete('rs-fleet-lab-1'); // docker rm
    await a.tick();
    expect(starts(docker)).toBe(1);
    expect(memory().held).toEqual({});
    fail(docker);
    await a.tick();
    expect(memory().license_outage).toEqual({ 'lab-1': { attempts: 0, jitter: 0 } });
  });

  it('several in an outage at once start one at a time, a stagger apart', async () => {
    server.desired = desired({ count: 3, vnc_ports: {} });
    const docker = new FakeDocker();
    for (const id of ['lab-1', 'lab-2', 'lab-3']) fail(docker, id);
    const a = agent(docker, { random: () => 0, staggerMs: 3 * MIN });
    clock += 6 * MIN;
    await a.tick();
    expect(docker.commands).toEqual([['start', 'rs-fleet-lab-1']]);
    expect(memory().license_outage['lab-1'].attempts).toBe(1);
    expect(memory().license_outage['lab-2'].attempts).toBe(0);
    clock += 2 * MIN;
    await a.tick();
    expect(docker.commands).toEqual([['start', 'rs-fleet-lab-1']]);
    clock += MIN;
    await a.tick();
    expect(docker.commands).toEqual([['start', 'rs-fleet-lab-1'], ['start', 'rs-fleet-lab-2']]);
    clock += 3 * MIN;
    await a.tick();
    expect(docker.commands.at(-1)).toEqual(['start', 'rs-fleet-lab-3']);
    expect(memory().license_outage['lab-3'].attempts).toBe(1);
  });

  it('recreates a spent ticket online, counted once even when the ticket is refused', async () => {
    server.desired = desired({ leases: {} });
    const docker = new FakeDocker();
    docker.containers.set('rs-fleet-lab-1', { ...fail(docker), ticket: true });
    const a = agent(docker, { random: () => 0 });
    await a.tick();
    clock += 5 * MIN;
    server.ticketAnswer = 500;
    expect((await a.tick()).errors).toEqual(['lab-1: no claim ticket from the ERP; not started']);
    expect(docker.commands.map((c) => c[0])).toEqual(['ensure', 'stop+rm']);
    expect(memory().license_outage['lab-1'].attempts).toBe(1);
    server.ticketAnswer = 200;
    clock += MIN;
    await a.tick();
    expect(docker.commands.map((c) => c[0])).toEqual(['ensure', 'stop+rm', 'ensure', 'run']);
    expect(memory().license_outage['lab-1'].attempts).toBe(1);
  });
});
