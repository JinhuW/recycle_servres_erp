// Test databases. The claim logic under test depends on real Postgres row
// locking (FOR UPDATE SKIP LOCKED), which no in-memory fake reproduces, so
// every test file gets its own throwaway database on a real server.

import postgres from 'postgres';
import {runMigrations} from '../../scripts/migrate.ts';
import {createDb, type Sql} from '../../src/db.ts';

const ADMIN_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://tracker:tracker@127.0.0.1:5433/postgres';

export interface TestDb {
  readonly sql: Sql;
  readonly url: string;
  drop(): Promise<void>;
}

function urlFor(database: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Creates a migrated, empty-of-test-data database and returns a client for it.
 * Call `drop()` in afterAll so servers do not accumulate stale databases.
 */
export async function createTestDb(label: string): Promise<TestDb> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `tracker_test_${label}_${suffix}`.toLowerCase();

  const admin = postgres(ADMIN_URL, {max: 1, onnotice: () => {}});
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = urlFor(name);
  await runMigrations(url, {quiet: true});

  // Migrations seed four subreddits; tests want to control the fixture set.
  const sql = createDb(url, 8);
  await sql`DELETE FROM subreddits`;

  return {
    sql,
    url,
    async drop() {
      await sql.end();
      const dropper = postgres(ADMIN_URL, {max: 1, onnotice: () => {}});
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
