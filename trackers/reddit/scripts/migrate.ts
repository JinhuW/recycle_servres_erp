#!/usr/bin/env tsx
// Applies migrations/*.sql against DATABASE_URL exactly once each.
// Use --reset to drop every table in the public schema first (dev only).

import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import 'dotenv/config';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

// Dedicated to this runner; distinct from the ERP's key so the two projects
// can share a Postgres cluster without blocking each other.
const MIGRATE_LOCK_KEY = 778431;

export async function runMigrations(
  databaseUrl: string,
  options: {reset?: boolean; quiet?: boolean} = {},
): Promise<void> {
  const log = options.quiet ? () => {} : console.log;
  const sql = postgres(databaseUrl, {onnotice: () => {}});

  try {
    // Every VM runs migrate on boot; the cluster-wide lock stops 10
    // simultaneous starts from all reading an empty ledger and double-applying.
    await sql`SELECT pg_advisory_lock(${MIGRATE_LOCK_KEY})`;

    if (options.reset) {
      log('· Dropping existing tables…');
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

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = new Set(
      (await sql`SELECT filename FROM schema_migrations`).map((r) => r['filename'] as string),
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        log(`↻ skip (already applied) ${file}`);
        continue;
      }
      log(`→ ${file}`);
      const ddl = readFileSync(join(migrationsDir, file), 'utf8');
      // One transaction per file: a mid-file failure rolls back the whole
      // file and the ledger row is only written once the DDL fully succeeded,
      // so a crashed migration never half-applies nor records itself.
      await sql.begin(async (tx) => {
        await tx.unsafe(ddl);
        await tx`INSERT INTO schema_migrations (filename) VALUES (${file})
                 ON CONFLICT (filename) DO NOTHING`;
      });
    }
    log('✓ migrations applied');
  } finally {
    try {
      await sql`SELECT pg_advisory_unlock(${MIGRATE_LOCK_KEY})`;
    } catch {
      // Session is ending anyway; the lock is released with the connection.
    }
    await sql.end();
  }
}

const isCliEntry = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isCliEntry) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
    process.exit(1);
  }
  const reset = process.argv.includes('--reset');
  if (reset && process.env['NODE_ENV'] === 'production'
      && process.env['ALLOW_DESTRUCTIVE_RESET'] !== 'true') {
    console.error(
      '✗ --reset is not allowed in production (NODE_ENV=production).\n'
      + '  If you really mean it, re-run with ALLOW_DESTRUCTIVE_RESET=true as well.',
    );
    process.exit(1);
  }
  try {
    await runMigrations(url, {reset});
  } catch (e) {
    console.error('✗ migration failed:', e);
    process.exit(1);
  }
}
