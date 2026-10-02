import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { TEST_DATABASE_URL } from './helpers/db';

// migrate.mjs must apply each .sql file exactly once via a schema_migrations
// ledger, instead of blindly re-running every file on every boot (which makes
// non-idempotent backfills like 0027/0031 re-execute on each restart).
// Verified on a throwaway scratch DB so the shared test DB is never touched.

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..');
const migrateScript = join(backendRoot, 'scripts', 'migrate.mjs');
const migrationsDir = join(backendRoot, 'migrations');
const SCRATCH = 'recycle_erp_ledger_test';
const adminUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, '/postgres');
const scratchUrl = TEST_DATABASE_URL.replace(/\/[^/]+$/, '/' + SCRATCH);

const fileCount = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).length;

function runMigrate() {
  return spawnSync('node', [migrateScript], {
    env: { ...process.env, DATABASE_URL: scratchUrl },
    encoding: 'utf8',
  });
}

describe('migrate.mjs schema_migrations ledger', () => {
  let admin: postgres.Sql;
  let db: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(adminUrl, { onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH}`);
    db = postgres(scratchUrl, { onnotice: () => {} });
  }, 30_000);

  afterAll(async () => {
    if (db) await db.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
      await admin.end();
    }
  });

  it('records every applied file once and skips already-applied files on re-run', async () => {
    const r1 = runMigrate();
    expect(r1.status).toBe(0);

    const after1 = await db<{ filename: string; applied_at: string }[]>`
      SELECT filename, applied_at FROM schema_migrations ORDER BY filename
    `;
    expect(after1.length).toBe(fileCount);

    // Second run with no changes is a no-op: same rows, same applied_at
    // timestamps (nothing re-applied, nothing re-recorded).
    const r2 = runMigrate();
    expect(r2.status).toBe(0);
    const after2 = await db<{ filename: string; applied_at: string }[]>`
      SELECT filename, applied_at FROM schema_migrations ORDER BY filename
    `;
    expect(after2.length).toBe(fileCount);
    expect(after2.map(x => x.applied_at)).toEqual(after1.map(x => x.applied_at));

    // Drop one ledger row → only that file should re-apply on the next run;
    // every other file stays skipped (applied_at unchanged).
    const victim = after1[0].filename;
    await db`DELETE FROM schema_migrations WHERE filename = ${victim}`;
    const r3 = runMigrate();
    expect(r3.status).toBe(0);
    const after3 = await db<{ filename: string; applied_at: string }[]>`
      SELECT filename, applied_at FROM schema_migrations ORDER BY filename
    `;
    expect(after3.length).toBe(fileCount); // victim re-recorded
    for (const row of after3) {
      if (row.filename === victim) continue;
      const prev = after1.find(x => x.filename === row.filename)!;
      expect(row.applied_at).toEqual(prev.applied_at); // others untouched
    }
  }, 60_000);

  // A migration stuck behind another session's lock gives up after the lock
  // timeout and is retried, instead of queueing every query behind it or
  // failing boot outright.
  it('retries a file that timed out waiting for a lock', async () => {
    const file = '0145_packages_tracking_status_at.sql';
    await db`ALTER TABLE packages DROP COLUMN IF EXISTS tracking_status_at`;
    await db`DELETE FROM schema_migrations WHERE filename = ${file}`;

    const holder = postgres(scratchUrl, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const held = holder.begin(async (tx) => {
      await tx`LOCK TABLE packages IN ACCESS EXCLUSIVE MODE`;
      await new Promise<void>((r) => { release = r; });
    });
    await new Promise((r) => setTimeout(r, 300)); // the lock is taken

    const child = spawn('node', [migrateScript], { env: { ...process.env, DATABASE_URL: scratchUrl } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise<number | null>((r) => child.on('exit', r));
    // Past one 10s lock timeout, then let the retry through.
    await new Promise((r) => setTimeout(r, 11_000));
    release();
    await held;
    await holder.end();

    expect(await exited).toBe(0);
    expect(out).toContain('waited too long for a lock; retrying');
    const [row] = await db<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM schema_migrations WHERE filename = ${file}`;
    expect(row.n).toBe(1);
  }, 60_000);

  // Runs after the test above, against the same scratch ledger.
  it('records a checksum per file, backfills a missing one, and warns on an edited file', async () => {
    const sha = (f: string) =>
      createHash('sha256').update(readFileSync(join(migrationsDir, f), 'utf8')).digest('hex');
    const rows = await db<{ filename: string; checksum: string | null }[]>`
      SELECT filename, checksum FROM schema_migrations ORDER BY filename
    `;
    const [first, second] = rows;
    expect(first.checksum).toBe(sha(first.filename));

    await db`UPDATE schema_migrations SET checksum = NULL WHERE filename = ${first.filename}`;
    await db`UPDATE schema_migrations SET checksum = 'edited' WHERE filename = ${second.filename}`;
    const r = runMigrate();
    expect(r.status).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain('applied migration has changed on disk');
    expect(out).toContain(second.filename);

    const [backfilled] = await db<{ checksum: string }[]>`
      SELECT checksum FROM schema_migrations WHERE filename = ${first.filename}
    `;
    expect(backfilled.checksum).toBe(sha(first.filename));
  }, 60_000);
});
