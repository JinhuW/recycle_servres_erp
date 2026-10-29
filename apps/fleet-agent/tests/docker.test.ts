import { describe, expect, it } from 'vitest';
import { containerOf, DockerCli, runArgs, runEnv, type Runner, type RunResult } from '../src/docker.js';

const TICKET = 'fct_made-up-claim-ticket';
const SPEC = { worker_id: 'lab-2', image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', port: 5902, ticket: TICKET };
const ENV = { url: 'https://erp.example', hostId: 'lab' };

describe('docker run', () => {
  it('is exactly the contract\'s line', () => {
    expect(runArgs('lab', SPEC).join(' ')).toBe(
      'run -d --name rs-fleet-lab-2 --label rs.fleet.host=lab --label rs.fleet.worker=lab-2 --label rs.fleet.claim_ticket=1 ' +
        '--restart no --shm-size 1g ' +
        '-e RS_FLEET_URL -e RS_FLEET_HOST_ID -e RS_FLEET_CLAIM_TICKET -e RS_FLEET_HOST_TOKEN -e RS_FLEET_WORKER_ID -e RS_VNC_PORT=5902 ' +
        '-p 127.0.0.1:5902:5900 -- ghcr.io/jinhuw/aimm-recycle:0.14.0',
    );
  });

  it('hands the worker its claim ticket through the CLI\'s environment, never argv, and never the host token', () => {
    expect(runArgs('lab', SPEC).join(' ')).not.toContain(TICKET);
    // The ticket goes out under the old name too: a worker image before
    // facebook-tracker 0.14.5 claims with RS_FLEET_HOST_TOKEN only.
    expect(runEnv(SPEC, ENV)).toEqual({
      RS_FLEET_URL: 'https://erp.example',
      RS_FLEET_HOST_ID: 'lab',
      RS_FLEET_CLAIM_TICKET: TICKET,
      RS_FLEET_HOST_TOKEN: TICKET,
      RS_FLEET_WORKER_ID: 'lab-2',
    });
  });

  it('passes the OpenSearch target only when the agent has one', () => {
    const opensearch = { url: 'http://10.0.0.5:9200', index: 'fb-tracker' };
    const args = runArgs('lab', SPEC, { ...ENV, opensearch }).join(' ');
    expect(args).toContain('-e RS_VNC_PORT=5902 -e AIMM_OPENSEARCH_URL -e AIMM_OPENSEARCH_INDEX -p 127.0.0.1:5902:5900');
    expect(runEnv(SPEC, { ...ENV, opensearch })).toMatchObject({
      AIMM_OPENSEARCH_URL: 'http://10.0.0.5:9200',
      AIMM_OPENSEARCH_INDEX: 'fb-tracker',
    });
    expect(runArgs('lab', SPEC, ENV)).toEqual(runArgs('lab', SPEC));
    expect(runEnv(SPEC, ENV)).not.toHaveProperty('AIMM_OPENSEARCH_URL');
  });
});

function recorder(answers: Record<string, Partial<RunResult>> = {}) {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const runner: Runner = async (args, opts) => {
    calls.push({ args, env: opts.env });
    const key = args.slice(0, 2).join(' ');
    return { code: 0, stdout: '', stderr: '', ...(answers[key] ?? {}) };
  };
  return { calls, runner };
}

const INSPECT = [
  {
    Name: '/rs-fleet-lab-1',
    Config: { Image: 'img:1', Labels: { 'rs.fleet.host': 'lab', 'rs.fleet.worker': 'lab-1' } },
    State: { Status: 'running', Running: true, ExitCode: 0, StartedAt: '2026-10-24T10:00:00.1Z', FinishedAt: '0001-01-01T00:00:00Z' },
  },
  {
    Name: '/rs-fleet-lab-2',
    Config: { Image: 'img:1', Labels: { 'rs.fleet.host': 'lab', 'rs.fleet.worker': 'lab-2' } },
    State: { Status: 'exited', Running: false, ExitCode: 75, StartedAt: '2026-10-24T10:00:00Z', FinishedAt: '2026-10-24T11:00:00Z' },
  },
  { Name: '/unlabelled', Config: { Image: 'x', Labels: {} }, State: { Status: 'running', Running: true } },
];

describe('observe', () => {
  it('filters by the host label and reads state from inspect', async () => {
    const { calls, runner } = recorder({ 'ps -a': { stdout: 'aaa\nbbb\nccc\n' }, 'inspect aaa': { stdout: JSON.stringify(INSPECT) } });
    const found = await new DockerCli(runner).observe('lab');
    expect(calls[0].args).toEqual(['ps', '-a', '-q', '--no-trunc', '--filter', 'label=rs.fleet.host=lab']);
    expect(calls[1].args).toEqual(['inspect', 'aaa', 'bbb', 'ccc']);
    expect(found).toEqual([
      { name: 'rs-fleet-lab-1', worker_id: 'lab-1', image: 'img:1', status: 'running', running: true, exit_code: null, started_at: '2026-10-24T10:00:00.1Z', finished_at: null },
      { name: 'rs-fleet-lab-2', worker_id: 'lab-2', image: 'img:1', status: 'exited', running: false, exit_code: 75, started_at: '2026-10-24T10:00:00Z', finished_at: '2026-10-24T11:00:00Z' },
    ]);
  });

  it('answers an empty list without inspecting anything', async () => {
    const { calls, runner } = recorder({ 'ps -a': { stdout: '\n' } });
    expect(await new DockerCli(runner).observe('lab')).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('answers null when the daemon does not', async () => {
    const { runner } = recorder({ 'ps -a': { code: 1, stderr: 'Cannot connect to the Docker daemon' } });
    expect(await new DockerCli(runner).observe('lab')).toBeNull();
  });

  it('looks again when a container went away between ps and inspect', async () => {
    let inspects = 0;
    const runner: Runner = async (args) => {
      if (args[0] === 'ps') return { code: 0, stdout: 'aaa\n', stderr: '' };
      inspects++;
      return inspects === 1 ? { code: 1, stdout: '[]', stderr: 'Error: No such object: bbb' } : { code: 0, stdout: JSON.stringify([INSPECT[0]]), stderr: '' };
    };
    expect((await new DockerCli(runner).observe('lab'))?.map((c) => c.worker_id)).toEqual(['lab-1']);
  });

  it('reads the container and image ids and a handoff label', () => {
    expect(containerOf({ ...INSPECT[1], Id: 'f00', Image: 'sha256:abc', Config: { ...INSPECT[1].Config, Labels: { ...INSPECT[1].Config.Labels, 'rs.fleet.handoff_epoch': '3' } } }))
      .toMatchObject({ id: 'f00', image_id: 'sha256:abc', handoff: true });
  });

  it('reads the claim ticket label', () => {
    expect(containerOf({ ...INSPECT[1], Config: { ...INSPECT[1].Config, Labels: { ...INSPECT[1].Config.Labels, 'rs.fleet.claim_ticket': '1' } } }))
      .toMatchObject({ ticket: true });
    expect(containerOf(INSPECT[1])).not.toHaveProperty('ticket');
  });

  it('ignores a record without the worker label', () => {
    expect(containerOf(INSPECT[2])).toBeNull();
  });
});

describe('acting', () => {
  it('pulls a tag every time, and uses the local copy only when the registry cannot be reached', async () => {
    const fresh = recorder();
    expect(await new DockerCli(fresh.runner).ensureImage('img:1')).toBeNull();
    expect(fresh.calls.map((c) => c.args)).toEqual([['pull', '--', 'img:1']]);
    const offline = recorder({ 'pull --': { code: 1, stderr: 'registry unreachable' } });
    expect(await new DockerCli(offline.runner).ensureImage('img:1')).toBeNull();
    expect(offline.calls.map((c) => c.args)).toEqual([['pull', '--', 'img:1'], ['image', 'inspect', '--', 'img:1']]);
    const denied = recorder({ 'pull --': { code: 1, stderr: 'pull access denied' }, 'image inspect': { code: 1 } });
    expect(await new DockerCli(denied.runner).ensureImage('img:1')).toBe('docker pull img:1: pull access denied');
  });

  it('pulls a digest only when it is missing: it cannot change', async () => {
    const ref = `ghcr.io/jinhuw/aimm-recycle@sha256:${'a'.repeat(64)}`;
    const present = recorder();
    expect(await new DockerCli(present.runner).ensureImage(ref)).toBeNull();
    expect(present.calls.map((c) => c.args)).toEqual([['image', 'inspect', '--', ref]]);
    const absent = recorder({ 'image inspect': { code: 1, stderr: 'No such image' } });
    expect(await new DockerCli(absent.runner).ensureImage(ref)).toBeNull();
    expect(absent.calls.map((c) => c.args[0])).toEqual(['image', 'pull']);
  });

  it('never lets an image name read as an option', () => {
    const args = runArgs('lab', { ...SPEC, image: '--privileged' });
    expect(args.slice(-2)).toEqual(['--', '--privileged']);
  });

  it('runs with the worker variables in the environment', async () => {
    const { calls, runner } = recorder();
    expect(await new DockerCli(runner).run(SPEC, ENV)).toBeNull();
    expect(calls[0].args).toEqual(runArgs('lab', SPEC));
    expect(calls[0].env).toEqual(runEnv(SPEC, ENV));
    const withSearch = { ...ENV, opensearch: { url: 'http://10.0.0.5:9200', index: 'fb-tracker' } };
    expect(await new DockerCli(runner).run(SPEC, withSearch)).toBeNull();
    expect(calls[1].args).toContain('AIMM_OPENSEARCH_URL');
    expect(calls[1].env).toMatchObject({ AIMM_OPENSEARCH_URL: 'http://10.0.0.5:9200' });
  });

  it('stops with time to save the session, then removes', async () => {
    const { calls, runner } = recorder();
    expect(await new DockerCli(runner).stopAndRemove('rs-fleet-lab-2')).toBeNull();
    expect(calls.map((c) => c.args)).toEqual([['stop', '-t', '30', 'rs-fleet-lab-2'], ['rm', 'rs-fleet-lab-2']]);
  });

  it('counts a container that is already gone as removed', async () => {
    const gone = recorder({ 'stop -t': { code: 1, stderr: 'Error response from daemon: No such container: rs-fleet-lab-2' } });
    expect(await new DockerCli(gone.runner).stopAndRemove('rs-fleet-lab-2')).toBeNull();
    const stuck = recorder({ 'stop -t': { code: 1, stderr: 'Error response from daemon: cannot stop container' } });
    expect(await new DockerCli(stuck.runner).stopAndRemove('rs-fleet-lab-2')).toMatch(/cannot stop/);
  });

  it('reports the last line of a failure', async () => {
    const { runner } = recorder({ 'start rs-fleet-lab-2': { code: 1, stderr: 'Error response from daemon: No such container: rs-fleet-lab-2\n' } });
    expect(await new DockerCli(runner).start('rs-fleet-lab-2')).toBe('docker start rs-fleet-lab-2: Error response from daemon: No such container: rs-fleet-lab-2');
  });
});

it('passes the confirmed stopped epoch to the replacement entrypoint', () => {
  const args = runArgs('lab', { ...SPEC, handoff_epoch: 7 });
  expect(args).toContain('RS_FLEET_HANDOFF_EPOCH=7');
  expect(args.join(' ')).not.toContain(TICKET);
});

describe('other agents', () => {
  const agentRecord = (name: string, hostname: string, hostId = 'lab') => ({
    Id: name, Name: `/${name}`, Config: { Hostname: hostname, Env: [`FLEET_HOST_ID=${hostId}`, 'FLEET_HOST_TOKEN=x'] },
  });

  it('finds another agent for the same host, not itself, not workers, not other hosts', async () => {
    const records = [agentRecord('me', 'selfhost'), agentRecord('twin', 'abc123'), agentRecord('neighbour', 'def456', 'other')];
    const { calls, runner } = recorder({
      'ps --no-trunc': { stdout: 'me \ntwin \nneighbour \nworker lab\n' },
      'inspect me': { stdout: JSON.stringify(records) },
    });
    expect(await new DockerCli(runner, 'selfhost').otherAgents('lab')).toEqual(['twin']);
    expect(calls[1].args).toEqual(['inspect', 'me', 'twin', 'neighbour']);
  });

  it('reads the daemon id', async () => {
    const { runner } = recorder({ 'info --format': { stdout: 'ABCD:EFGH\n' } });
    expect(await new DockerCli(runner).daemonId()).toBe('ABCD:EFGH');
  });
});
