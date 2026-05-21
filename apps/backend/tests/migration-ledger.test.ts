import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
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
});
