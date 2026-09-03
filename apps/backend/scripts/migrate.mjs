#!/usr/bin/env node
// Run SQL files in ./migrations against DATABASE_URL.
// Use --reset to DROP all known tables first (dev only).

import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import './load-env.mjs';
// Plain-node import of a .ts module: Node strips the types. log.ts is kept
// free of intra-repo imports so this resolves without a transpiler.
import { log as rootLog } from '../src/lib/log.ts';

const log = rootLog.child({ module: 'migrate' });

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

const url = process.env.DATABASE_URL;
if (!url) {
  log.error('DATABASE_URL is not set. Add it to the repo-root .env');
  process.exit(1);
}

// Short connect timeout because this runner retries; the postgres.js default of
// 30s would spend the whole restart budget on two attempts.
const sql = postgres(url, { onnotice: () => {}, connect_timeout: 5 });
const reset = process.argv.includes('--reset');

// The container's CMD chains on `&&`: a failure here means the server never
// starts, Railway's ON_FAILURE policy burns its retries, and the service then
// stays down *after* Postgres comes back — it needs a human to redeploy. A
// database that is merely slow to accept connections during a deploy is a
// transient, so wait it out rather than turning it into an outage. Only the
// connect is retried; a migration that fails on its SQL still exits non-zero
// immediately, which is the behaviour you want.
const CONNECT_ATTEMPTS = 6;

async function connectWithRetry(statement) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await statement();
    } catch (err) {
      if (attempt >= CONNECT_ATTEMPTS) throw err;
      const waitMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      log.warn('database not reachable yet; retrying', {
        attempt, of: CONNECT_ATTEMPTS, waitMs, error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

if (reset && process.env.NODE_ENV === 'production' && process.env.ALLOW_DESTRUCTIVE_RESET !== 'true') {
  log.error(
    '--reset is not allowed in production (NODE_ENV=production). ' +
    'If you really mean it, re-run with ALLOW_DESTRUCTIVE_RESET=true as well.',
  );
  process.exit(1);
}

// Cluster-wide lock so two instances starting at once (rolling deploy,
// compose --scale) can't both read an empty ledger and double-apply.
const MIGRATE_LOCK_KEY = 778423; // arbitrary, dedicated to this runner

try {
  // First statement of the run, so this is where a cold/absent database shows up.
  await connectWithRetry(() => sql`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`);
  if (reset) {
    log.warn('dropping existing tables');
    // Drop everything in the public schema (dev-only). Older versions of this
    // script hard-coded a fixed table list which silently went stale every time
    // we added a migration — switch to discovering tables at runtime so reset
    // stays correct as schema grows.
    await sql.unsafe(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `);
  }

  // Ledger so each migration runs exactly once. Without it every .sql
  // re-ran on every boot — fine for IF-NOT-EXISTS DDL, but non-idempotent
  // backfills (0027/0031) re-executed each restart and rescanned all rows.
  // On --reset the table was just dropped, so it starts empty and every
  // file (re)applies once against the fresh DB.
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const applied = new Set(
    (await sql`SELECT filename FROM schema_migrations`).map(r => r.filename),
  );

  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  let appliedNow = 0;
  for (const file of files) {
    if (applied.has(file)) {
      log.info('skip (already applied)', { file });
      continue;
    }
    log.info('applying migration', { file });
    const ddl = readFileSync(join(migrationsDir, file), 'utf8');
    // One transaction per file: a mid-file failure rolls the whole file
    // back, and the ledger row is only written if the DDL fully succeeded —
    // so a crashed migration never half-applies and never records itself.
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})
               ON CONFLICT (filename) DO NOTHING`;
    });
    appliedNow++;
  }
  log.info('migrations applied', { applied: appliedNow, total: files.length });
} catch (e) {
  log.error('migration failed', e);
  process.exitCode = 1;
} finally {
  try { await sql`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`; } catch { /* session ending anyway */ }
  await sql.end();
}
