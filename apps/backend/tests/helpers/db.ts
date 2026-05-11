import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..', '..');
const migrationsDir = join(backendRoot, 'migrations');
const seedScript = join(backendRoot, 'scripts', 'seed.mjs');

// Load TEST_DATABASE_URL from .dev.vars if not in env already (vitest runs
// outside of wrangler, so process.env isn't auto-populated).
function loadDevVars(): void {
  if (process.env.TEST_DATABASE_URL) return;
  try {
    const raw = readFileSync(join(backendRoot, '.dev.vars'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch (_) { /* ok */ }
}
loadDevVars();

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL!;
if (!TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL not set — add it to apps/backend/.dev.vars');
}

let sql: postgres.Sql | null = null;
export function getTestDb() {
  if (!sql) sql = postgres(TEST_DATABASE_URL, { onnotice: () => {} });
  return sql;
}

export async function resetDb(): Promise<void> {
  const db = getTestDb();
  // Drop everything in public schema (mirrors what migrate.mjs --reset does).
  await db.unsafe(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sqlText = readFileSync(join(migrationsDir, f), 'utf8');
    await db.unsafe(sqlText);
  }
  // Run the existing seed.mjs against TEST_DATABASE_URL
  const r = spawnSync('node', [seedScript], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`seed failed: ${r.stderr}\n${r.stdout}`);
  }
}

export async function closeTestDb(): Promise<void> {
  if (sql) { await sql.end({ timeout: 1 }); sql = null; }
}
