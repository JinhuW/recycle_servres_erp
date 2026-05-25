import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendErrorRecord, _resetForTests } from '../src/lib/error-log';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'errlog-'));
  _resetForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('appendErrorRecord', () => {
  it('appends a JSON line to errors.jsonl', async () => {
    await appendErrorRecord(dir, {
      ts: '2026-05-25T00:00:00.000Z',
      requestId: 'req-1',
      method: 'GET',
      path: '/api/orders/1',
      message: 'boom',
    });

    const body = readFileSync(join(dir, 'errors.jsonl'), 'utf8');
    expect(body.endsWith('\n')).toBe(true);
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      ts: '2026-05-25T00:00:00.000Z',
      requestId: 'req-1',
      method: 'GET',
      path: '/api/orders/1',
      message: 'boom',
    });
  });

  it('appends multiple records as separate lines', async () => {
    await appendErrorRecord(dir, { ts: 't1', requestId: 'a', method: 'GET', path: '/x', message: 'm1' });
    await appendErrorRecord(dir, { ts: 't2', requestId: 'b', method: 'POST', path: '/y', message: 'm2' });

    const lines = readFileSync(join(dir, 'errors.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).requestId).toBe('a');
    expect(JSON.parse(lines[1]).requestId).toBe('b');
  });

  it('creates the directory if missing', async () => {
    const nested = join(dir, 'sub', 'errors');
    await appendErrorRecord(nested, { ts: 't', requestId: 'r', method: 'GET', path: '/x', message: 'm' });
    expect(statSync(join(nested, 'errors.jsonl')).isFile()).toBe(true);
  });

  it('rotates when errors.jsonl reaches maxBytes', async () => {
    // Pre-fill the live file to the cap so the next append triggers rotation.
    const live = join(dir, 'errors.jsonl');
    writeFileSync(live, 'x'.repeat(1000));

    await appendErrorRecord(dir, { ts: 't', requestId: 'r', method: 'GET', path: '/x', message: 'm' }, {
      maxBytes: 1000,
      maxFiles: 5,
    });

    const files = readdirSync(dir).sort();
    expect(files).toContain('errors.jsonl');
    const rotated = files.filter((f) => f.startsWith('errors-') && f.endsWith('.jsonl'));
    expect(rotated).toHaveLength(1);
    // Fresh live file has exactly the one new record.
    const liveLines = readFileSync(live, 'utf8').trim().split('\n');
    expect(liveLines).toHaveLength(1);
    expect(JSON.parse(liveLines[0]).requestId).toBe('r');
  });

  it('prunes oldest rotated files beyond maxFiles', async () => {
    // Seed 3 rotated files with mtimes 3s/2s/1s ago.
    const now = Date.now();
    const old = [
      'errors-20260101-000000.jsonl',
      'errors-20260102-000000.jsonl',
      'errors-20260103-000000.jsonl',
    ];
    for (let i = 0; i < old.length; i++) {
      const p = join(dir, old[i]);
      writeFileSync(p, 'old\n');
      // Stagger mtimes so prune order is unambiguous.
      const { utimesSync } = await import('node:fs');
      const t = (now - (old.length - i) * 1000) / 1000;
      utimesSync(p, t, t);
    }
    // Fill live so next append rotates.
    writeFileSync(join(dir, 'errors.jsonl'), 'x'.repeat(1000));

    await appendErrorRecord(dir, { ts: 't', requestId: 'r', method: 'GET', path: '/x', message: 'm' }, {
      maxBytes: 1000,
      maxFiles: 2, // keep only 2 rotated; we'll have 4 after rotation, so prune 2
    });

    const rotated = readdirSync(dir).filter((f) => f.startsWith('errors-')).sort();
    expect(rotated).toHaveLength(2);
    // Oldest two should be gone.
    expect(rotated).not.toContain('errors-20260101-000000.jsonl');
    expect(rotated).not.toContain('errors-20260102-000000.jsonl');
  });

  it('serializes concurrent appends without interleaving', async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      appendErrorRecord(dir, {
        ts: `t${i}`,
        requestId: `r${i}`,
        method: 'GET',
        path: '/x',
        message: 'a'.repeat(200),
      }),
    );
    await Promise.all(writes);

    const lines = readFileSync(join(dir, 'errors.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(20);
    // Every line must parse — interleaved bytes would break JSON.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('swallows write failures without throwing', async () => {
    // Point at a path that cannot be created (a file in the way).
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'i am a file');
    const bad = join(blocker, 'nested');

    await expect(
      appendErrorRecord(bad, { ts: 't', requestId: 'r', method: 'GET', path: '/x', message: 'm' }),
    ).resolves.toBeUndefined();
  });
});
