import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbTarget, destructiveRefusal } from '../src/lib/dbTarget';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
// .invalid never resolves, so a script that skipped its guard would fail on
// DNS instead of printing the refusal — either way nothing is touched.
const REMOTE = 'postgres://u:p@db.example.invalid:5432/prod';

describe('destructive scripts refuse a remote DATABASE_URL', () => {
  it.each([
    { name: 'seed.mjs', args: [join(scripts, 'seed.mjs')], override: 'ALLOW_DESTRUCTIVE_SEED' },
    { name: 'migrate.mjs --reset', args: [join(scripts, 'migrate.mjs'), '--reset'], override: 'ALLOW_DESTRUCTIVE_RESET' },
  ])('$name exits 1 before connecting', ({ args, override }) => {
    const r = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: REMOTE, [override]: '', NODE_ENV: 'development' },
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('db.example.invalid, which is not a local database');
  });

  // The compose service host is local in dev and the real database on a
  // self-hosted prod stack; only NODE_ENV tells the two apart.
  it('seed.mjs refuses the compose host under NODE_ENV=production', () => {
    const r = spawnSync(process.execPath, [join(scripts, 'seed.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env, DATABASE_URL: 'postgres://u:p@postgres:5432/x',
        ALLOW_DESTRUCTIVE_SEED: '', NODE_ENV: 'production',
      },
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('NODE_ENV is production');
  });
});

describe('dbTarget', () => {
  it('treats loopback and the compose service as local', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', 'postgres']) {
      expect(dbTarget(`postgres://u:p@${h}:5432/x`).local).toBe(true);
    }
    expect(dbTarget('postgres://u:p@postgres.railway.internal:5432/x').local).toBe(false);
  });

  it('refuses production whatever the host, unless overridden', () => {
    const local = 'postgres://u:p@postgres:5432/x';
    expect(destructiveRefusal(local, 'seed', 'ALLOW_X', { NODE_ENV: 'production' }))
      .toContain('NODE_ENV is production');
    expect(destructiveRefusal(local, 'seed', 'ALLOW_X', { NODE_ENV: 'production', ALLOW_X: 'true' }))
      .toBeNull();
    expect(destructiveRefusal(local, 'seed', 'ALLOW_X', { NODE_ENV: 'development' })).toBeNull();
  });

  it('lets the named override through', () => {
    expect(destructiveRefusal(REMOTE, 'seed', 'ALLOW_X', { ALLOW_X: 'true' })).toBeNull();
    expect(destructiveRefusal(REMOTE, 'seed', 'ALLOW_X', { ALLOW_X: '1' })).toContain('refused');
  });
});
