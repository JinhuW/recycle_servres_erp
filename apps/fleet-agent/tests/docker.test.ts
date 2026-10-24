import { describe, expect, it } from 'vitest';
import { containerOf, DockerCli, runArgs, runEnv, type Runner, type RunResult } from '../src/docker.js';

const SPEC = { worker_id: 'lab-2', image: 'ghcr.io/jinhuw/aimm-recycle:0.14.0', port: 5902 };
const ENV = { url: 'https://erp.example', hostId: 'lab', token: 'made-up-host-token' };

describe('docker run', () => {
  it('is exactly the contract\'s line', () => {
    expect(runArgs('lab', SPEC).join(' ')).toBe(
      'run -d --name rs-fleet-lab-2 --label rs.fleet.host=lab --label rs.fleet.worker=lab-2 --restart no --shm-size 1g ' +
        '-e RS_FLEET_URL -e RS_FLEET_HOST_ID -e RS_FLEET_HOST_TOKEN -e RS_FLEET_WORKER_ID -e RS_VNC_PORT=5902 ' +
        '-p 127.0.0.1:5902:5900 ghcr.io/jinhuw/aimm-recycle:0.14.0',
    );
  });

  it('hands the token to the CLI through its environment, never argv', () => {
    expect(runArgs('lab', SPEC).join(' ')).not.toContain(ENV.token);
    expect(runEnv(SPEC, ENV)).toEqual({
      RS_FLEET_URL: 'https://erp.example',
      RS_FLEET_HOST_ID: 'lab',
      RS_FLEET_HOST_TOKEN: 'made-up-host-token',
      RS_FLEET_WORKER_ID: 'lab-2',
    });
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

  it('ignores a record without the worker label', () => {
    expect(containerOf(INSPECT[2])).toBeNull();
  });
});

describe('acting', () => {
  it('pulls only when the image is missing', async () => {
    const present = recorder();
    expect(await new DockerCli(present.runner).ensureImage('img:1')).toBeNull();
    expect(present.calls.map((c) => c.args[0])).toEqual(['image']);
    const absent = recorder({ 'image inspect': { code: 1, stderr: 'No such image' } });
    expect(await new DockerCli(absent.runner).ensureImage('img:1')).toBeNull();
    expect(absent.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['image inspect', 'pull img:1']);
    const denied = recorder({ 'image inspect': { code: 1 }, 'pull img:1': { code: 1, stderr: 'pull access denied' } });
    expect(await new DockerCli(denied.runner).ensureImage('img:1')).toBe('docker pull img:1: pull access denied');
  });

  it('runs with the worker variables in the environment', async () => {
    const { calls, runner } = recorder();
    expect(await new DockerCli(runner).run(SPEC, ENV)).toBeNull();
    expect(calls[0].args).toEqual(runArgs('lab', SPEC));
    expect(calls[0].env).toEqual(runEnv(SPEC, ENV));
  });

  it('stops with time to save the session, then removes', async () => {
    const { calls, runner } = recorder();
    expect(await new DockerCli(runner).stopAndRemove('rs-fleet-lab-2')).toBeNull();
    expect(calls.map((c) => c.args)).toEqual([['stop', '-t', '30', 'rs-fleet-lab-2'], ['rm', 'rs-fleet-lab-2']]);
  });

  it('reports the last line of a failure', async () => {
    const { runner } = recorder({ 'start rs-fleet-lab-2': { code: 1, stderr: 'Error response from daemon: No such container: rs-fleet-lab-2\n' } });
    expect(await new DockerCli(runner).start('rs-fleet-lab-2')).toBe('docker start rs-fleet-lab-2: Error response from daemon: No such container: rs-fleet-lab-2');
  });
});
