import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Give each `vitest run` its OWN ephemeral database.
//
// The suite resets the schema per-test (resetDb → drop-all + migrate + seed).
// When two runs shared ONE database (a release's gate racing a dev's local
// run, or CI racing a local run), one run's drop-all dropped tables out from
// under the other run's in-flight queries → "relation \"users\" does not
// exist" and a cascade of login 500s. resetDb's advisory lock only serialises
// reset-vs-reset within a process; it can't stop another process dropping the
// shared schema mid-query. A private database per run removes the shared
// state entirely, so concurrent runs can't collide.
//
// This is the durable replacement for the shared-DB + advisory-lock scheme.
// The lock stays in resetDb (harmless, guards intra-run edge cases); this just
// makes sure no two runs ever point at the same database.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

function baseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const raw = readFileSync(join(repoRoot, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^TEST_DATABASE_URL=(.*)$/);
    if (m) return m[1];
  }
  throw new Error('TEST_DATABASE_URL not set — add it to the repo-root .env');
}

// CREATE/DROP DATABASE can't target the DB you're connected to, so run them
// from the always-present `postgres` maintenance database on the same cluster.
function adminUrl(base: string): string {
  const u = new URL(base);
  u.pathname = '/postgres';
  return u.toString();
}

export default async function setup() {
  const base = baseUrl();
  const u = new URL(base);
  const baseDbName = u.pathname.replace(/^\//, '') || 'recycle_erp_test';
  // Unique, valid identifier (≤63 chars). pid + base-36 time is readable and
  // collision-free across concurrent runs on one host.
  const runDb = `${baseDbName}_${process.pid}_${Date.now().toString(36)}`;

  const admin = postgres(adminUrl(base), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${runDb}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  // Point every test connection — resetDb's pool, the app-under-test pool, and
  // the seed subprocess (all read TEST_DATABASE_URL) — at the ephemeral DB.
  // globalSetup runs before the worker forks, so they inherit this env var.
  u.pathname = `/${runDb}`;
  process.env.TEST_DATABASE_URL = u.toString();

  // Teardown: drop the ephemeral DB. Terminate any lingering backends first so
  // DROP doesn't trip "database is being accessed by other users".
  return async () => {
    const a = postgres(adminUrl(base), { max: 1, onnotice: () => {} });
    try {
      await a.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
           WHERE datname = '${runDb}' AND pid <> pg_backend_pid()`,
      );
      await a.unsafe(`DROP DATABASE IF EXISTS "${runDb}"`);
    } finally {
      await a.end({ timeout: 5 });
    }
  };
}
