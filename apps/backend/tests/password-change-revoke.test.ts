import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { issueRefresh, rotateRefresh } from '../src/auth';
import { updateMember } from '../src/services/members';

// H2 regression: deactivateMember revokes a user's refresh tokens, but the
// password-change branch of updateMember did not. Resetting a compromised
// user's password must invalidate their existing (possibly stolen) refresh
// tokens, otherwise an attacker keeps rotating for up to the RT lifetime.

describe('updateMember password change revokes refresh tokens', () => {
  beforeEach(async () => { await resetDb(); });

  it('invalidates existing refresh tokens when the password is changed', async () => {
    const db = getTestDb();
    const uid = (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;

    const { raw } = await issueRefresh(db, uid);
    // Sanity: the token works before the password change.
    expect((await rotateRefresh(db, raw)).ok).toBe(true);

    const { raw: raw2 } = await issueRefresh(db, uid);
    await updateMember(db, uid, { password: 'a-new-password-123' });

    expect((await rotateRefresh(db, raw2)).ok).toBe(false);
  });

  it('does not revoke tokens for a metadata-only update', async () => {
    const db = getTestDb();
    const uid = (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;

    const { raw } = await issueRefresh(db, uid);
    await updateMember(db, uid, { title: 'Senior Buyer' });

    expect((await rotateRefresh(db, raw)).ok).toBe(true);
  });
});
