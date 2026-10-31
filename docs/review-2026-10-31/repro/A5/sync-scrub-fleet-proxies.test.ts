// A5-01 repro. Copy to apps/backend/tests/, run with TEST_DATABASE_URL pointing
// at a disposable PG18, then delete the copy. Asserts the CURRENT (broken)
// behaviour: scrub.sql aborts as soon as prod has one fleet_proxies row,
// because its *_enc loop writes NULL into the NOT NULL url_enc column (0213).
// This is the error the dev db-sync job has logged every night since 2026-10-28.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';

const scrub = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deploy', 'railway-sync', 'scrub.sql'),
  'utf8',
);

describe('A5-01 scrub vs fleet_proxies', () => {
  beforeEach(async () => { await resetDb(); });

  it('fails the whole restore transaction when a fleet proxy exists', async () => {
    const sql = getTestDb();
    await sql`INSERT INTO fleet_proxies (label, url_enc, host, port, timezone)
              VALUES ('NJ1', 'v1.a.b.c', 'isp.example.net', 10018, 'America/New_York')`;
    await expect(sql.begin(async (tx) => {
      await tx`SELECT pg_catalog.set_config('search_path', '', true)`;
      await tx.unsafe(scrub);
    })).rejects.toThrow(/null value in column "url_enc" of relation "fleet_proxies"/);
  });
});
