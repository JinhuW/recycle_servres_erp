import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminUrl } from './pg-urls';

// Give each `vitest run` its OWN ephemeral databases.
//
// When two runs shared ONE database (a release's gate racing a dev's local
// run, or CI racing a local run), one run's reset dropped tables out from
// under the other run's in-flight queries → "relation \"users\" does not
// exist" and a cascade of login 500s. So this only mints a run-scoped name
// prefix and hands it to the workers via TEST_DATABASE_URL; nothing is shared
// between runs.
//
// Each worker then owns `<run>_w<poolId>` plus a migrated + seeded
// `<run>_w<poolId>_tmpl` template (db.ts → ensureWorkerDb), and resetDb
// re-clones the working DB from that template per test. A worker runs its
// files sequentially, so resetDb takes no lock; the only advisory lock left
// serialises template migrations across workers on one cluster.

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

export default async function setup() {
  const base = baseUrl();
  const u = new URL(base);
  const baseDbName = (u.pathname.replace(/^\//, '') || 'recycle_erp_test');
  // Unique, valid identifier (≤63 chars). pid + base-36 time is readable and
  // collision-free across concurrent runs on one host. Sanitised to
  // [A-Za-z0-9_] so the interpolated DDL below can't be anything but a bare
  // identifier — the value is internally generated (config + pid + clock),
  // never user input, but this makes that property structural.
  const runDb = `${baseDbName}_${process.pid}_${Date.now().toString(36)}`
    .replace(/[^A-Za-z0-9_]/g, '_');

  // We don't create `runDb` itself — it's only a name prefix. Each vitest
  // worker creates its own `<runDb>_w<poolId>` database (see db.ts →
  // ensureWorkerDb) so test files run in parallel against private databases.
  // globalSetup runs before the workers fork, so they inherit this env var.
  u.pathname = `/${runDb}`;
  process.env.TEST_DATABASE_URL = u.toString();

  // Teardown: drop every per-worker DB this run created. Terminate any lingering
  // backends first so DROP doesn't trip "database is being accessed by others".
  return async () => {
    const a = postgres(adminUrl(base), { max: 1, onnotice: () => {} });
    try {
      // `\_` matches a literal underscore (LIKE treats bare `_` as a wildcard).
      const dbs = await a<{ datname: string }[]>`
        SELECT datname FROM pg_database WHERE datname LIKE ${runDb + '\\_w%'}
      `;
      for (const { datname } of dbs) {
        await a.unsafe( // nosec — datname is prefix-matched against our sanitised run name
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
             WHERE datname = '${datname}' AND pid <> pg_backend_pid()`,
        );
        await a.unsafe(`DROP DATABASE IF EXISTS "${datname}"`); // nosec — internal, prefix-matched identifier
      }
    } finally {
      await a.end({ timeout: 5 });
    }
  };
}
