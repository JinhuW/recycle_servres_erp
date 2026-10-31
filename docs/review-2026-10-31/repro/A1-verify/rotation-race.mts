// A1-01 repro: a refresh rotation in flight while the password change /
// deactivation revoke runs leaves its successor alive.
// Run: cd apps/backend && DB=postgres://postgres:review@127.0.0.1:55701/postgres \
//   node_modules/.bin/tsx ../../docs/review-2026-10-31/repro/A1-verify/rotation-race.mts
// Determinism: a test-only AFTER INSERT trigger sleeps 1s, so the rotating
// transaction holds its row lock and its uncommitted successor while the
// revoke statement runs (the real window is the gap between INSERT and COMMIT).
import { createRequire } from 'node:module';
const BE = '/Users/jinhu/orca/workspaces/recycle_servres_erp/brant/apps/backend';
const require = createRequire(BE + '/package.json');
const postgres = require('postgres');
const { issueRefresh, rotateRefresh } = await import(BE + '/src/auth.ts');
const { issueRefreshToken, rotateRefreshToken, revokeUserOAuthTokens } = await import(BE + '/src/oauth/tokens.ts');
const { deactivateMember, updateMember } = await import(BE + '/src/services/members.ts');

const sql = postgres(process.env.DB!, { max: 6, onnotice: () => {} });
const env: any = {};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const out: Record<string, unknown> = {};

await sql`DROP TRIGGER IF EXISTS slow_rt ON refresh_tokens`;
await sql`DROP TRIGGER IF EXISTS slow_ort ON oauth_refresh_tokens`;
await sql`CREATE OR REPLACE FUNCTION repro_slow() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF current_setting('repro.slow', true) = 'on' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$`;
await sql`CREATE TRIGGER slow_rt AFTER INSERT ON refresh_tokens FOR EACH ROW EXECUTE FUNCTION repro_slow()`;
await sql`CREATE TRIGGER slow_ort AFTER INSERT ON oauth_refresh_tokens FOR EACH ROW EXECUTE FUNCTION repro_slow()`;
// Only the rotating connection sleeps: set the GUC on the whole DB for new sessions is too broad,
// so wrap rotation in a pool whose connections carry the setting.
const slow = postgres(process.env.DB!, { max: 2, onnotice: () => {}, connection: { 'repro.slow': 'on' } });

async function mkUser(tag: string) {
  const [u] = await sql`INSERT INTO users (email,name,initials,role,password_hash)
    VALUES (${tag + '-' + Date.now() + '@x.test'}, ${tag}, 'XX', 'manager', 'x') RETURNING id`;
  // a second manager so deactivation passes the last-manager guard
  await sql`INSERT INTO users (email,name,initials,role,password_hash)
    VALUES (${tag + '-m2-' + Date.now() + '@x.test'}, 'm2', 'MM', 'manager', 'x')`;
  return u.id as string;
}
const live = async (table: string, fam: string) =>
  Number((await sql`SELECT count(*)::int AS n FROM ${sql(table)} WHERE family_id = ${fam} AND revoked_at IS NULL`)[0].n);

// 1. Self password change (exact SQL of routes/me.ts:186-203), caller in family B, thief in family A.
{
  const uid = await mkUser('pw');
  const thief = await issueRefresh(sql, uid);
  const caller = await issueRefresh(sql, uid);
  const rot = rotateRefresh(slow, thief.raw);
  await sleep(300);
  await sql.begin(async (tx: any) => {
    await tx`UPDATE users SET password_hash='y', tokens_valid_after=now(), credential_version=credential_version+1 WHERE id=${uid}`;
    await tx`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id=${uid} AND revoked_at IS NULL AND family_id != ${caller.familyId}`;
    await revokeUserOAuthTokens(tx, uid);
  });
  const r = await rot;
  const again = r.ok ? await rotateRefresh(sql, r.raw) : { ok: false };
  out.selfPasswordChange = { rotationInFlight_ok: r.ok, thiefFamilyLiveRowsAfterRevoke: await live('refresh_tokens', thief.familyId), successorStillRotates: again.ok };
}
// Control: same without overlap.
{
  const uid = await mkUser('ctl');
  const thief = await issueRefresh(sql, uid);
  await updateMember(sql, uid, { password: 'another-password-123' });
  out.control_noOverlap = { rotate_ok: (await rotateRefresh(sql, thief.raw)).ok };
}
// 2. Deactivation during rotation, then reactivation.
{
  const uid = await mkUser('deact');
  const thief = await issueRefresh(sql, uid);
  const rot = rotateRefresh(slow, thief.raw);
  await sleep(300);
  await deactivateMember(sql, uid);
  const r = await rot;
  const whileInactive = r.ok ? await rotateRefresh(sql, r.raw) : { ok: false };
  await updateMember(sql, uid, { active: true });
  // the inactive refusal returns ok:false WITHOUT revoking, so r.raw is still usable
  const afterReactivate = r.ok ? await rotateRefresh(sql, r.raw) : { ok: false };
  out.deactivation = { rotationInFlight_ok: r.ok, refusedWhileInactive: !whileInactive.ok, successorRotatesAfterReactivation: afterReactivate.ok, liveRows: await live('refresh_tokens', thief.familyId) };
}
// 3. OAuth grant during admin password reset (updateMember -> revokeUserOAuthTokens).
{
  const uid = await mkUser('oauth');
  const cid = 'repro-client-' + Date.now();
  await sql`INSERT INTO oauth_clients (id,name,redirect_uris,grant_types,scopes) VALUES (${cid},'r','{http://127.0.0.1/cb}','{authorization_code,refresh_token}','{market:read}')`;
  const g = await issueRefreshToken(sql, env, { clientId: cid, userId: uid, scopes: ['market:read'] });
  const rot = rotateRefreshToken(slow, env, g.raw, cid);
  await sleep(300);
  // same statements as routes/me.ts (hash computed before the tx, as there)
  await sql.begin(async (tx: any) => {
    await tx`UPDATE users SET password_hash='y', tokens_valid_after=now(), credential_version=credential_version+1 WHERE id=${uid}`;
    await tx`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id=${uid} AND revoked_at IS NULL`;
    await revokeUserOAuthTokens(tx, uid);
  });
  const r: any = await rot;
  const again: any = r.ok ? await rotateRefreshToken(sql, env, r.raw, cid) : { ok: false };
  out.oauthSelfPasswordChange = { rotationInFlight_ok: r.ok, liveRowsAfter: await live('oauth_refresh_tokens', g.familyId), successorStillRotates: again.ok, cvMatchesCurrent: again.ok ? again.credentialVersion === (await sql`SELECT credential_version FROM users WHERE id=${uid}`)[0].credential_version : null };
}
// 4. OAuth grant during deactivation, reactivated before the successor is next presented.
{
  const uid = await mkUser('oauthdeact');
  const cid = 'repro-client2-' + Date.now();
  await sql`INSERT INTO oauth_clients (id,name,redirect_uris,grant_types,scopes) VALUES (${cid},'r','{http://127.0.0.1/cb}','{authorization_code,refresh_token}','{market:read}')`;
  const g = await issueRefreshToken(sql, env, { clientId: cid, userId: uid, scopes: ['market:read'] });
  const rot = rotateRefreshToken(slow, env, g.raw, cid);
  await sleep(300);
  await deactivateMember(sql, uid);
  const r: any = await rot;
  await updateMember(sql, uid, { active: true });
  const again: any = r.ok ? await rotateRefreshToken(sql, env, r.raw, cid) : { ok: false };
  out.oauthDeactivateThenReactivate = { rotationInFlight_ok: r.ok, successorRotatesAfterReactivation: again.ok };
}
console.log(JSON.stringify(out, null, 1));
await sql`DROP TRIGGER slow_rt ON refresh_tokens`; await sql`DROP TRIGGER slow_ort ON oauth_refresh_tokens`;
await slow.end(); await sql.end(); process.exit(0);
