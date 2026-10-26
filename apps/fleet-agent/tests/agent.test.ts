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

function agent(docker: FakeDocker, over: { staggerMs?: number; url?: string; token?: string; imagePrefixes?: string[]; keepaliveMs?: number } = {}) {
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

  it('frees the account when it removes an extra', async () => {
    const docker = new FakeDocker([running('lab-1'), running('lab-2')]);
    server.desired = desired({ count: 1, leases: { 'lab-2': { account_no: 9, epoch: 4 } } });
    expect((await agent(docker).tick()).errors).toEqual([]);
    expect(server.stopped).toEqual([expect.objectContaining({ worker_id: 'lab-2', account_no: 9, epoch: 4, restart: false })]);
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
