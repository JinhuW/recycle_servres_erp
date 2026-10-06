import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resetDb, getTestDb } from './helpers/db';
import { loginAs, ALEX } from './helpers/auth';

// The nightly prod→dev copy runs this inside its restore transaction with
// ON_ERROR_STOP. Running it here against the fully migrated schema means a new
// FK onto a scrubbed table — which makes the TRUNCATE fail — fails CI, not the
// 04:00 restore on dev.  It runs after the dump, whose preamble empties
// search_path for the rest of the session, so it runs that way here too.
const scrub = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'deploy', 'railway-sync', 'scrub.sql'),
  'utf8',
);

describe('prod→dev sync scrub', () => {
  beforeEach(async () => { await resetDb(); });

  it('clears every live credential and keeps the users', async () => {
    const sql = getTestDb();
    await loginAs(ALEX);
    const { createOAuthClient } = await import('../src/oauth/clients');
    await createOAuthClient(sql, {
      name: 'scraper', redirectUris: [], grantTypes: ['client_credentials'],
      scopes: ['market:read'], createdBy: null, public: false,
    });
    const users = (await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM users`)[0].n;

    await sql.begin(async (tx) => {
      await tx`SELECT pg_catalog.set_config('search_path', '', true)`;
      await tx.unsafe(scrub);
    });

    const [left] = await sql<Record<string, number>[]>`
      SELECT
        (SELECT COUNT(*)::int FROM refresh_tokens) AS refresh,
        (SELECT COUNT(*)::int FROM oauth_refresh_tokens) AS oauth_refresh,
        (SELECT COUNT(*)::int FROM oauth_authorization_codes) AS codes,
        (SELECT COUNT(*)::int FROM oauth_pending_consent) AS pending,
        (SELECT COUNT(*)::int FROM login_attempts) AS attempts,
        (SELECT COUNT(*)::int FROM oauth_clients WHERE secret_hash IS NOT NULL OR revoked_at IS NULL) AS live_clients
    `;
    expect(left).toEqual({ refresh: 0, oauth_refresh: 0, codes: 0, pending: 0, attempts: 0, live_clients: 0 });
    expect((await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM users`)[0].n).toBe(users);
  });
});
