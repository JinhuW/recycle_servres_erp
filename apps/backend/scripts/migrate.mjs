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

// Read .dev.vars too (Wrangler-style file with KEY=VALUE lines)
function loadDevVars() {
  try {
    const raw = readFileSync(join(here, '..', '.dev.vars'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (_) { /* fine if missing */ }
}
loadDevVars();

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to backend/.dev.vars');
  process.exit(1);
}

const sql = postgres(url, { onnotice: () => {} });
const reset = process.argv.includes('--reset');

try {
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

  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log('→ ' + file);
    const ddl = readFileSync(join(migrationsDir, file), 'utf8');
    await sql.unsafe(ddl);
  }
  console.log('✓ migrations applied');
} catch (e) {
  console.error('✗ migration failed:', e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
