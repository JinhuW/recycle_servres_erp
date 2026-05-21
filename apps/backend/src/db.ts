// Postgres client. Connection string comes from DATABASE_URL.
//
// One shared, lazily-created pool for the whole process. The backend runs
// under @hono/node-server (Node) where module-scope sockets are fine — the
// old "new pool per request" design (a Cloudflare Workers I/O-scoping
// workaround) meant N concurrent requests opened up to N*`max` connections
// and exhausted Postgres' max_connections under load. postgres.js already
// pools and is concurrency-safe, so a single shared pool is correct here.

import postgres from 'postgres';
import type { Env } from './types';

type Sql = ReturnType<typeof postgres>;

// One shared pool per distinct connection string. Production has exactly one
// DATABASE_URL, so this is a single process-wide shared pool; tests that
// inject an alternate URL (e.g. to simulate the DB being unreachable) get
// their own pool keyed by that URL rather than silently reusing the first.
const pools = new Map<string, Sql>();

export function getDb(env: Env): Sql {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured');
  let pool = pools.get(url);
  if (!pool) {
    pool = postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false, // disable prepared statements (safe with poolers; no perf need here)
    });
    pools.set(url, pool);
  }
  return pool;
}

// Close every shared pool. Intended for test teardown / graceful shutdown so
// the process can exit without dangling sockets. Safe to call when none
// have been created.
export async function closeSharedDb(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(
    all.map(p => p.end({ timeout: 5 }).catch(() => { /* already closed */ })),
  );
}

// Hono middleware: previously bound a per-request pool. The shared pool now
// lives for the process lifetime, so this is a passthrough kept only so the
// existing `app.use('*', (c, next) => dbScope(c, next))` mount is unchanged.
export async function dbScope(
  _c: { env: Env },
  next: () => Promise<void>,
): Promise<void> {
  await next();
}
