// Postgres client. Uses Hyperdrive's connection string when bound, otherwise
// falls back to DATABASE_URL — same code path either way.
//
// IMPORTANT: in Cloudflare Workers, I/O objects (sockets, streams) are scoped
// to the request that created them — caching a pg client at module scope
// triggers "Cannot perform I/O on behalf of a different request". So we create
// a fresh client per call. postgres-js opens connections lazily, and in
// production Hyperdrive does the actual pooling on its side.

import postgres from 'postgres';
import type { Env } from './types';

export function getDb(env: Env) {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not configured');
  return postgres(url, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // Hyperdrive doesn't support prepared statements
  });
}
