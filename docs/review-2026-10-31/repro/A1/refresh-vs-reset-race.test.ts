// A1-01 / A1-02 repro (review 2026-10-31). Asserts the CURRENT, defective
// behaviour; it is evidence, not a regression gate.
//
// A1-01: a refresh rotation that is mid-transaction when the signed-in user
// changes their password (POST /api/me/password) inserts a successor row the
// password change's revoke UPDATE never sees (its statement snapshot predates
// the rotation's commit, and the row it blocked on is already revoked), so the
// session the user meant to evict keeps a live refresh family. The OAuth
// refresh rotation has the same shape.
//
// A1-02: the same rotation racing a manager's reset (PATCH /api/members/:id,
// which takes users FOR UPDATE) deadlocks instead: the rotation's INSERT needs
// FOR KEY SHARE on the user row for its FK check while holding the old token
// row the reset wants to revoke. One side is aborted with 40P01 → HTTP 500.
//
// Windows are widened deterministically with a sleeping trigger inside the
// rotation's transaction (disposable test DB only). Both sides run real code.
//
// Run (from apps/backend, against a disposable Postgres 18):
//   TEST_DATABASE_URL=postgres://postgres:review@127.0.0.1:55601/postgres \
//     npx vitest run --config ../../docs/review-2026-10-31/repro/A1/vitest.config.ts
import { resetDb, getTestDb } from '../../../../apps/backend/tests/helpers/db';
import { api, testEnv } from '../../../../apps/backend/tests/helpers/app';
import { loginAs, ALEX, MARCUS } from '../../../../apps/backend/tests/helpers/auth';
import { createOAuthClient } from '../../../../apps/backend/src/oauth/clients';
import { issueRefreshToken, rotateRefreshToken } from '../../../../apps/backend/src/oauth/tokens';

const H = { 'X-Requested-By': 'recycle-erp' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// AFTER: fires after the FK check (RI triggers sort first), so the rotation
// holds its key-share on users and its old-row lock while it sleeps.
// BEFORE: fires before the FK check, leaving room for another transaction to
// take the user row first.
async function slowInserts(table: string, when: 'BEFORE' | 'AFTER' | null) {
  const db = getTestDb();
  await db.unsafe(`DROP TRIGGER IF EXISTS a1_slow ON ${table}`);
  if (!when) return;
  await db.unsafe(`CREATE OR REPLACE FUNCTION a1_slow() RETURNS trigger AS $$
    BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$ LANGUAGE plpgsql`);
  await db.unsafe(`CREATE TRIGGER a1_slow ${when} INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION a1_slow()`);
}

describe('A1-01: refresh rotation racing a self password change', () => {
  beforeEach(async () => { await resetDb(); });

  it('the other (stolen) cookie session survives the password change', async () => {
    const legit = await loginAs(MARCUS);
    const stolen = await loginAs(MARCUS);      // a second family: the device to evict

    await slowInserts('refresh_tokens', 'AFTER');
    const refreshing = api('POST', '/api/auth/refresh', { headers: H, cookies: { rt: stolen.cookies.rt } });
    await sleep(300);
    const change = await api('POST', '/api/me/password', {
      headers: H, cookies: { at: legit.cookies.at },
      body: { currentPassword: 'demo', newPassword: 'brand-new-password-1' },
    });
    const refreshed = await refreshing;
    await slowInserts('refresh_tokens', null);

    expect(change.status).toBe(200);
    expect(refreshed.status).toBe(200);
    const rt2 = refreshed.setCookies.rt;
    expect(rt2).toBeTruthy();

    // After the change committed, the evicted session refreshes again…
    const again = await api('POST', '/api/auth/refresh', { headers: H, cookies: { rt: rt2 } });
    expect(again.status).toBe(200);           // DEFECT: should be 401
    // …and the access token it gets, minted under the new credential_version,
    // is accepted.
    const me = await api('GET', '/api/me', { cookies: { at: again.setCookies.at } });
    expect(me.status).toBe(200);               // DEFECT: should be 401
  });

  it('an OAuth refresh family survives the password change and mints a current-cv token', async () => {
    const db = getTestDb();
    const legit = await loginAs(MARCUS);
    const uid = legit.user.id;
    const { clientId } = await createOAuthClient(db, {
      name: 'a1-repro', redirectUris: ['https://example.test/cb'],
      grantTypes: ['authorization_code', 'refresh_token'], scopes: ['market:read'],
      createdBy: null, public: true,
    });
    const first = await issueRefreshToken(db, testEnv, { clientId, userId: uid, scopes: ['market:read'] });

    await slowInserts('oauth_refresh_tokens', 'AFTER');
    const rotating = rotateRefreshToken(db, testEnv, first.raw, clientId);
    await sleep(300);
    const change = await api('POST', '/api/me/password', {
      headers: H, cookies: { at: legit.cookies.at },
      body: { currentPassword: 'demo', newPassword: 'brand-new-password-1' },
    });
    const rotated = await rotating;
    await slowInserts('oauth_refresh_tokens', null);

    expect(change.status).toBe(200);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    const [{ cv }] = await db<{ cv: number }[]>`SELECT credential_version AS cv FROM users WHERE id = ${uid}`;
    const next = await rotateRefreshToken(db, testEnv, rotated.raw, clientId);
    expect(next.ok).toBe(true);                // DEFECT: should be revoked
    if (next.ok) expect(next.credentialVersion).toBe(cv); // so bearerGuard accepts its access token
  });
});

describe('A1-02: refresh rotation racing a manager password reset', () => {
  beforeEach(async () => { await resetDb(); });

  it('deadlocks; one of the two requests answers 500', async () => {
    const manager = await loginAs(ALEX);
    const victim = await loginAs(MARCUS);

    await slowInserts('refresh_tokens', 'BEFORE');
    const refreshing = api('POST', '/api/auth/refresh', { headers: H, cookies: { rt: victim.cookies.rt } });
    await sleep(300);
    const reset = await api('PATCH', `/api/members/${victim.user.id}`, {
      headers: H, cookies: { at: manager.cookies.at }, body: { password: 'brand-new-password-1' },
    });
    const refreshed = await refreshing;
    await slowInserts('refresh_tokens', null);

    expect([reset.status, refreshed.status]).toContain(500);   // DEFECT: 40P01 surfaced as 500
  });
});
