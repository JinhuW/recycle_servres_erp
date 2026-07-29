import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { log, releaseCommit, releaseVersion } from '../src/lib/log';
import { appendErrorRecord, _resetForTests } from '../src/lib/error-log';
import { api } from './helpers/app';

// The point of the module: no caller ever passes a version, yet no line can
// ship without one. These tests guard that invariant, not the formatting.

let out: string[];
let err: string[];
let saved: Record<string, string | undefined>;

const ENV_KEYS = ['APP_VERSION', 'GIT_SHA', 'RAILWAY_GIT_COMMIT_SHA', 'LOG_LEVEL'];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
  vi.spyOn(console, 'error').mockImplementation((line: string) => { err.push(line); });
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('log', () => {
  it('stamps version and commit on every level without the caller passing them', () => {
    process.env.APP_VERSION = '9.9.9';
    process.env.GIT_SHA = 'deadbee';
    process.env.LOG_LEVEL = 'debug';

    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    const lines = [...out, ...err].map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line.version).toBe('9.9.9');
      expect(line.commit).toBe('deadbee');
      expect(typeof line.ts).toBe('string');
    }
    expect(lines.map((l) => l.level).sort()).toEqual(['debug', 'error', 'info', 'warn']);
  });

  it('sends info/debug to stdout and warn/error to stderr', () => {
    process.env.LOG_LEVEL = 'debug';
    log.info('i');
    log.error('e');
    expect(out).toHaveLength(1);
    expect(err).toHaveLength(1);
  });

  it('falls back to the root package version when the release args are empty', async () => {
    // Railway passes no build args and the Dockerfile bakes them as EMPTY
    // strings — this is exactly what a Railway container sees.
    process.env.APP_VERSION = '';
    process.env.GIT_SHA = '';
    process.env.RAILWAY_GIT_COMMIT_SHA = 'railwaysha123';

    log.info('hello');

    const rootPkg = await import('../../../package.json');
    const line = JSON.parse(out[0]);
    expect(line.version).toBe(rootPkg.version);
    expect(line.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(line.commit).toBe('railwaysha123');
    expect(releaseVersion()).toBe(rootPkg.version);
    expect(releaseCommit()).toBe('railwaysha123');
  });

  it('reports an unknown commit when nothing supplies one', () => {
    process.env.GIT_SHA = '';
    delete process.env.RAILWAY_GIT_COMMIT_SHA;
    log.info('hello');
    expect(JSON.parse(out[0]).commit).toBe('unknown');
  });

  it('unwraps an Error into message and stack', () => {
    log.error('r2 delete failed', new Error('boom'));
    const line = JSON.parse(err[0]);
    expect(line.message).toBe('r2 delete failed');
    expect(line.error).toBe('boom');
    expect(line.stack).toContain('boom');
  });

  it('merges structured detail and stringifies scalars', () => {
    log.info('request', { status: 404, path: '/x' });
    log.info('scalar', 42);
    expect(JSON.parse(out[0])).toMatchObject({ status: 404, path: '/x' });
    expect(JSON.parse(out[1]).detail).toBe(42);
  });

  it('child loggers inherit fields and still carry the version', () => {
    process.env.APP_VERSION = '9.9.9';
    const child = log.child({ module: 'fx' }).child({ requestId: 'req-1' });
    child.info('refresh');
    expect(JSON.parse(out[0])).toMatchObject({
      module: 'fx',
      requestId: 'req-1',
      version: '9.9.9',
    });
  });

  it('drops lines below LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'warn';
    log.debug('d');
    log.info('i');
    log.warn('w');
    expect(out).toHaveLength(0);
    expect(err).toHaveLength(1);
  });

  it('defaults to info when LOG_LEVEL is unset or nonsense', () => {
    delete process.env.LOG_LEVEL;
    log.debug('d');
    log.info('i');
    process.env.LOG_LEVEL = 'chatty';
    log.debug('d2');
    log.info('i2');
    expect(out.map((l) => JSON.parse(l).message)).toEqual(['i', 'i2']);
  });
});

describe('request logging', () => {
  it('logs one version-stamped line per request', async () => {
    process.env.APP_VERSION = '9.9.9';
    await api('GET', '/');
    const line = JSON.parse(out.at(-1)!);
    expect(line).toMatchObject({
      message: 'request',
      method: 'GET',
      path: '/',
      status: 200,
      version: '9.9.9',
    });
    expect(typeof line.requestId).toBe('string');
    expect(typeof line.ms).toBe('number');
  });

  it('redacts the vendor portal token from the logged path', async () => {
    // The token is the only gate to a vendor's data — a bearer-equivalent
    // secret that must never be replayable from the log stream.
    await api('GET', '/api/public/vendor/s3cr3t-token/does-not-exist');
    const line = JSON.parse(out.at(-1)!);
    expect(line.path).toBe('/api/public/vendor/<redacted>/does-not-exist');
    expect(out.join('\n')).not.toContain('s3cr3t-token');
  });
});

describe('appendErrorRecord version stamping', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'errlog-version-'));
    _resetForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stamps the running build onto records the caller never versioned', async () => {
    process.env.APP_VERSION = '9.9.9';
    process.env.GIT_SHA = 'deadbee';

    await appendErrorRecord(dir, {
      ts: '2026-07-29T00:00:00.000Z',
      requestId: 'req-1',
      message: 'boom',
    });

    const line = JSON.parse(readFileSync(join(dir, 'errors.jsonl'), 'utf8').trim());
    expect(line).toMatchObject({ version: '9.9.9', commit: 'deadbee', message: 'boom' });
  });
});
