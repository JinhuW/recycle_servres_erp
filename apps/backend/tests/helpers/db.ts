import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { closeSharedDb } from '../../src/db';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..', '..');
const repoRoot = join(backendRoot, '..', '..');
const migrationsDir = join(backendRoot, 'migrations');
const seedScript = join(backendRoot, 'scripts', 'seed.mjs');

// Load TEST_DATABASE_URL from the repo-root .env if not already in the
// environment (vitest runs as a plain Node process, so process.env isn't
// auto-populated).
function loadDevVars(): void {
  if (process.env.TEST_DATABASE_URL) return;
  try {
    const raw = readFileSync(join(repoRoot, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (_) { /* ok */ }
}
loadDevVars();

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

function adminUrl(base: string): string {
  const u = new URL(base);
  u.pathname = '/postgres'; // CREATE/DROP DATABASE must run from another DB
  return u.toString();
}

const workerDbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, '');
const templateDbName = `${workerDbName}_tmpl`;
function templateUrl(): string {
  const u = new URL(TEST_DATABASE_URL);
  u.pathname = `/${templateDbName}`;
  return u.toString();
}

// Build this worker's seeded TEMPLATE database once, then per-test resetDb just
// clones a fresh working DB from it (a ~30ms file copy) instead of replaying
// every migration + running the seed subprocess (~850ms). The template is
// migrated + seeded a single time per worker slot — the existence check makes
// it idempotent across the fresh processes vitest spawns per file. Called from
// setup.ts's beforeAll and (defensively) from resetDb.
let templateReady = false;
export async function ensureWorkerDb(): Promise<void> {
  if (templateReady || !process.env.VITEST_POOL_ID) return;
  templateReady = true;
  const admin = postgres(adminUrl(TEST_DATABASE_URL), { max: 1, onnotice: () => {} });
  try {
    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${templateDbName}`;
    if (exists.length > 0) return;
    await admin.unsafe(`CREATE DATABASE "${templateDbName}"`); // nosec — internal sanitised identifier
  } finally {
    await admin.end({ timeout: 5 });
  }
  // Migrate the template, then seed it (subprocess, exactly as before — but ONCE
  // per worker rather than once per test).
  const turl = templateUrl();
  const tsql = postgres(turl, { max: 1, onnotice: () => {} });
  try {
    const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const f of files) await tsql.unsafe(readFileSync(join(migrationsDir, f), 'utf8')); // nosec — trusted migration SQL from the repo's migrations dir
  } finally {
    await tsql.end({ timeout: 5 });
  }
  const r = spawnSync('node', [seedScript], {
    env: { ...process.env, DATABASE_URL: turl, SEED_POOL_MAX: '2' },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`seed (template) failed: ${r.stderr}\n${r.stdout}`);
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
