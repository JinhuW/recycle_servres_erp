// Postgres client factory. Every worker holds a small pool against the one
// shared database; keep max low because 10 VMs multiply it.

import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;

export function createDb(databaseUrl: string, max = 4): Sql {
  return postgres(databaseUrl, {
    max,
    // Railway's proxy drops idle connections; recycling them ourselves avoids
    // a dead-socket error on the first query after a quiet stretch.
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    connect_timeout: 15,
    onnotice: () => {},
  });
}
