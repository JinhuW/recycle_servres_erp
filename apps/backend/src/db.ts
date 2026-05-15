// Postgres client. Uses Hyperdrive's connection string when bound, otherwise
// falls back to DATABASE_URL — same code path either way.
//
// IMPORTANT: in Cloudflare Workers, I/O objects (sockets, streams) are scoped
// to the request that created them — caching a pg client at module scope
// triggers "Cannot perform I/O on behalf of a different request". So the
// client must be created *within* a request and torn down when that request
// ends. Previously `getDb()` created a brand-new pool on every call and never
// closed it, so each call leaked up to `max` connections until idle_timeout —
// route files call getDb many times per request, which exhausts Postgres'
// max_connections under any real load and takes the whole service down.
//
// Fix: one pooled client per request, stored in an AsyncLocalStorage so the
// 59 existing `getDb(c.env)` call sites keep working unchanged, and closed in
// the `dbScope` middleware's finally once the response is produced.

import postgres from 'postgres';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Env } from './types';

type Sql = ReturnType<typeof postgres>;

const requestDb = new AsyncLocalStorage<Sql>();

function createClient(env: Env): Sql {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured');
  return postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // Hyperdrive doesn't support prepared statements
  });
}

export function getDb(env: Env): Sql {
  // Inside a request the dbScope middleware has bound a shared client.
  const scoped = requestDb.getStore();
  if (scoped) return scoped;
  // Fallback for non-request contexts (scripts, direct unit calls). Callers
  // there own the lifecycle; this path is never hit on the request pathway.
  return createClient(env);
}

// Hono middleware: bind exactly one pooled client for the lifetime of the
// request, then close it once the response has been produced so the request's
// connections are released immediately instead of leaking until idle_timeout.
export async function dbScope(
  c: { env: Env },
  next: () => Promise<void>,
): Promise<void> {
  const client = createClient(c.env);
  try {
    await requestDb.run(client, next);
  } finally {
    try {
      await client.end({ timeout: 5 });
    } catch {
      /* already closed / nothing in flight */
    }
  }
}
