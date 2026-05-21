#!/usr/bin/env node
// Run SQL files in ./migrations against DATABASE_URL.
// Use --reset to DROP all known tables first (dev only).

import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to apps/backend/.env');
  process.exit(1);
}

const sql = postgres(url, { onnotice: () => {} });
const reset = process.argv.includes('--reset');

if (reset && process.env.NODE_ENV === 'production' && process.env.ALLOW_DESTRUCTIVE_RESET !== 'true') {
  console.error(
    '✗ --reset is not allowed in production (NODE_ENV=production).\n' +
    '  If you really mean it, re-run with ALLOW_DESTRUCTIVE_RESET=true as well.',
  );
  process.exit(1);
}

// Cluster-wide lock so two instances starting at once (rolling deploy,
// compose --scale) can't both read an empty ledger and double-apply.
const MIGRATE_LOCK_KEY = 778423; // arbitrary, dedicated to this runner

try {
  await sql`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`;
  if (reset) {
    console.log('· Dropping existing tables…');
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
  for (const file of files) {
    if (applied.has(file)) {
      console.log('↻ skip (already applied) ' + file);
      continue;
    }
    console.log('→ ' + file);
    const ddl = readFileSync(join(migrationsDir, file), 'utf8');
    // One transaction per file: a mid-file failure rolls the whole file
    // back, and the ledger row is only written if the DDL fully succeeded —
    // so a crashed migration never half-applies and never records itself.
    await sql.begin(async (tx) => {
      await tx.unsafe(ddl);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${file})
               ON CONFLICT (filename) DO NOTHING`;
    });
  }
  console.log('✓ migrations applied');
} catch (e) {
  console.error('✗ migration failed:', e);
  process.exitCode = 1;
} finally {
  try { await sql`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`; } catch { /* session ending anyway */ }
  await sql.end();
}
