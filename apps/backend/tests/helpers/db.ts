import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { closeSharedDb } from '../../src/db';
import { adminUrl } from './pg-urls';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..', '..');
const migrateScript = join(backendRoot, 'scripts', 'migrate.mjs');
const seedScript = join(backendRoot, 'scripts', 'seed.mjs');

// Each vitest worker (fork) gets its OWN database so test FILES can run in
// parallel without sharing schema/data. global-setup hands every worker the
// same run-scoped base name via TEST_DATABASE_URL; we suffix it with the
// fork's VITEST_POOL_ID (1..maxForks). Files that land on the same slot run
// sequentially and safely reuse that slot's DB. Outside vitest (no pool id),
// the base URL is used unchanged.
function resolveWorkerUrl(): string {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) {
    throw new Error('TEST_DATABASE_URL not set — add it to the repo-root .env');
  }
  const poolId = process.env.VITEST_POOL_ID;
  if (!poolId) return base;
  const u = new URL(base);
  const baseDb = u.pathname.replace(/^\//, '') || 'recycle_erp_test';
  u.pathname = '/' + `${baseDb}_w${poolId}`.replace(/[^A-Za-z0-9_]/g, '_');
  return u.toString();
}

export const TEST_DATABASE_URL = resolveWorkerUrl();

const workerDbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
const templateDbName = `${workerDbName}_tmpl`;
// Built under this name and renamed only once migrated AND seeded, so a build
// that dies part-way leaves nothing that passes for a ready template.
const buildingDbName = `${templateDbName}_building`;
function dbUrl(name: string): string {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

// Same key as scripts/migrate.mjs, for grep-ability. The scopes differ:
// migrate.mjs locks in its target database, this locks in the maintenance one.
const MIGRATE_LOCK_KEY = 778423;

// Build this worker's seeded TEMPLATE database once, then per-test resetDb just
// clones a fresh working DB from it (a ~30ms file copy) instead of replaying
// every migration + running the seed subprocess (~850ms). The template is
// migrated + seeded a single time per worker slot — the existence check makes
// it idempotent across the fresh processes vitest spawns per file. Called from
// setup.ts's beforeAll and (defensively) from resetDb.
//
// Migrations run through scripts/migrate.mjs, the runner production boots
// with: one transaction per file, the ledger, the lock timeout. Replaying the
// files bare let a migration that cannot run inside a transaction pass here
// and then fail the deploy.
//
// One build per process, shared: setup.ts's beforeAll and a file's resetDb
// both call this, and a hook that timed out leaves its build running — a
// second caller starting its own would DROP … WITH (FORCE) the first one's
// half-built database out from under it. A failed build is forgotten so the
// next caller retries.
let ready: Promise<void> | null = null;
export function ensureWorkerDb(): Promise<void> {
  if (!process.env.VITEST_POOL_ID) return Promise.resolve();
  ready ??= buildIfMissing().catch((e: unknown) => { ready = null; throw e; });
  return ready;
}

async function buildIfMissing(): Promise<void> {
  const admin = postgres(adminUrl(TEST_DATABASE_URL), { max: 1, onnotice: () => {} });
  try {
    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${templateDbName}`;
    if (exists.length === 0) await buildTemplate(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function buildTemplate(admin: postgres.Sql): Promise<void> {
  const burl = dbUrl(buildingDbName);
  await admin.unsafe(`DROP DATABASE IF EXISTS "${buildingDbName}" WITH (FORCE)`); // nosec — internal sanitised identifier
  await admin.unsafe(`CREATE DATABASE "${buildingDbName}"`); // nosec — internal sanitised identifier

  // Workers migrate their OWN databases, but migration 0042 creates the
  // cluster-wide `metrics` role behind an IF NOT EXISTS — a check-then-act,
  // not an atomic one. Two workers both see it absent, both CREATE ROLE, and
  // the loser dies on pg_authid's unique index with its template
  // half-migrated.
  //
  // The lock has to be held HERE, on the shared `postgres` maintenance
  // database, for the whole migrate run: advisory locks are scoped to the
  // database they're taken in, so migrate.mjs's own lock (taken in the
  // template it migrates) serialises nothing across workers.
  //
  // Only bites a FRESH cluster. Locally the role survives from an earlier
  // run, so the race is invisible until CI runs against a new container.
  await admin`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`;
  try {
    const m = spawnSync('node', [migrateScript], {
      env: { ...process.env, DATABASE_URL: burl },
      encoding: 'utf8',
    });
    if (m.status !== 0) throw new Error(`migrate (template) failed: ${m.stderr}\n${m.stdout}`);
  } finally {
    await admin`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`;
  }
  const r = spawnSync('node', [seedScript], {
    env: { ...process.env, DATABASE_URL: burl, SEED_POOL_MAX: '2' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`seed (template) failed: ${r.stderr}\n${r.stdout}`);
  await admin.unsafe(`ALTER DATABASE "${buildingDbName}" RENAME TO "${templateDbName}"`); // nosec — internal identifiers
}

let sql: postgres.Sql | null = null;
export function getTestDb() {
  // Small pool: one per worker process × many parallel workers must stay under
  // Postgres' max_connections.
  if (!sql) sql = postgres(TEST_DATABASE_URL, { max: 3, onnotice: () => {} });
  return sql;
}

// Restore a pristine, seeded database by dropping the working DB and re-cloning
// it from the worker's template (CREATE DATABASE ... TEMPLATE — a fast file
// copy). This replaces the old per-test drop→replay-migrations→seed-subprocess
// sequence (~850ms) with a ~30ms clone, and removes the per-test seed
// subprocess entirely (so the suite stays well under max_connections even at
// high parallelism). Each worker owns its template + working DB and runs its
// tests sequentially, so no cross-process lock is needed.
export async function resetDb(): Promise<void> {
  if (!process.env.VITEST_POOL_ID) {
    throw new Error('resetDb must run under vitest (per-worker database).');
  }
  await ensureWorkerDb(); // template must exist (idempotent no-op after the first)
  // Release this process's pooled connections so the working DB can be dropped.
  await closeTestDb();
  await closeSharedDb();
  const admin = postgres(adminUrl(TEST_DATABASE_URL), { max: 1, onnotice: () => {} });
  try {
    // Terminate any stragglers, drop, and re-clone from the seeded template.
    await admin.unsafe( // nosec — workerDbName is an internal sanitised identifier
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = '${workerDbName}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${workerDbName}"`); // nosec — internal identifier
    await admin.unsafe(`CREATE DATABASE "${workerDbName}" TEMPLATE "${templateDbName}"`); // nosec — internal identifiers
  } finally {
    await admin.end({ timeout: 5 });
  }
  // getTestDb()/getDb() reconnect lazily to the freshly-cloned working DB.
}

export async function closeTestDb(): Promise<void> {
  if (sql) { await sql.end({ timeout: 1 }); sql = null; }
}
