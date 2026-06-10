import { createHash, createPrivateKey, createPublicKey, randomBytes, type KeyObject } from 'node:crypto';
import { exportPKCS8, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import type postgres from 'postgres';
import type { Env, OAuthScope } from '../types';
import { oauthRefreshRevocationsTotal } from '../metrics';

type AnySql = postgres.Sql | postgres.TransactionSql;

const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');
const sec = (n?: string, d?: number) => Number.parseInt(n ?? String(d), 10) || (d ?? 0);

// Operator stores Ed25519 private keys in env as base64-encoded PKCS#8 PEM so
// .env doesn't have to wrap multi-line values.
export async function generateSigningKey(): Promise<string> {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const pem = await exportPKCS8(privateKey);
  return Buffer.from(pem).toString('base64');
}

// jose's importPKCS8 only yields a "private" CryptoKey, which can sign but not
// verify. Round-tripping through node's KeyObject lets us derive the matching
// public key for verification from the same env-stored secret.
function loadPrivateKey(b64: string): KeyObject {
  const pem = Buffer.from(b64, 'base64').toString('utf8');
  return createPrivateKey(pem);
}

function loadPublicKey(b64: string): KeyObject {
  return createPublicKey(loadPrivateKey(b64));
}

// Deterministic short kid derived from the key bytes; lets the verifier pick
// the matching key from the ring without exposing the key itself.
export function keyKid(b64: string): string {
  return sha256hex(b64).slice(0, 16);
}

export type AccessClaims = {
  iss: string;
  sub: string | null;
  cid: string;
  scopes: OAuthScope[];
  jti: string;
  exp: number;
  iat: number;
  aud: 'recycle-erp-api';
};

export async function signAccessToken(env: Env, input: {
  clientId: string; userId: string | null; scopes: OAuthScope[];
}): Promise<string> {
  if (!env.OAUTH_SIGNING_KEY_CURRENT) throw new Error('OAUTH_SIGNING_KEY_CURRENT not set');
  const key = loadPrivateKey(env.OAUTH_SIGNING_KEY_CURRENT);
  const kid = keyKid(env.OAUTH_SIGNING_KEY_CURRENT);
  const ttl = sec(env.OAUTH_ACCESS_TOKEN_TTL_SEC, 900);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ cid: input.clientId, scopes: input.scopes })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .setIssuer(env.OAUTH_ISSUER_URL ?? '')
    .setAudience('recycle-erp-api')
    .setSubject(input.userId ?? '')
    .setJti(randomBytes(16).toString('hex'))
    .sign(key);
}

export async function verifyAccessToken(env: Env, token: string): Promise<AccessClaims | null> {
  const candidates = [env.OAUTH_SIGNING_KEY_CURRENT, env.OAUTH_SIGNING_KEY_PREVIOUS]
    .filter((s): s is string => Boolean(s));
  for (const b64 of candidates) {
    try {
      const key = loadPublicKey(b64);
      const { payload } = await jwtVerify(token, key, {
        issuer: env.OAUTH_ISSUER_URL ?? '',
        audience: 'recycle-erp-api',
      });
      return {
        iss: payload.iss as string,
        sub: (payload.sub as string) || null,
        cid: payload.cid as string,
        scopes: payload.scopes as OAuthScope[],
        jti: payload.jti as string,
        exp: payload.exp as number,
        iat: payload.iat as number,
        aud: 'recycle-erp-api',
      };
    } catch { /* try next key in ring */ }
  }
  return null;
}

const opaqueToken = () => randomBytes(32).toString('hex');

// :write scopes are reserved for managers. Applied at consent time and
// re-derived from the live role on every refresh rotation so a demotion
// takes effect within one access-token lifetime.
const WRITE_SCOPES = new Set(['market:write', 'sellorder:write']);
export const dropWriteUnlessManager = (scopes: string[], role: string | undefined): string[] =>
  role === 'manager' ? scopes : scopes.filter(s => !WRITE_SCOPES.has(s));

export type IssueRefreshInput = {
  clientId: string;
  userId: string | null;
  scopes: OAuthScope[];
  familyId?: string;
  parentId?: number;
};

export async function issueRefreshToken(
  sql: AnySql,
  env: Env,
  input: IssueRefreshInput,
): Promise<{ raw: string; familyId: string; id: number }> {
  const raw = opaqueToken();
  const familyId = input.familyId ?? crypto.randomUUID();
  const ttl = sec(env.OAUTH_REFRESH_TOKEN_TTL_SEC, 2_592_000);
  const exp = new Date(Date.now() + ttl * 1000);
  const rows = await sql<{ id: number }[]>`
    INSERT INTO oauth_refresh_tokens
      (token_hash, client_id, user_id, scopes, family_id, parent_id, expires_at)
    VALUES
      (${sha256hex(raw)}, ${input.clientId}, ${input.userId}, ${input.scopes},
       ${familyId}, ${input.parentId ?? null}, ${exp})
    RETURNING id
  `;
  return { raw, familyId, id: rows[0].id };
}

export type RotateRefreshResult =
  | { ok: true; raw: string; clientId: string; userId: string | null; scopes: OAuthScope[]; familyId: string }
  | { ok: false; reason: 'not_found' | 'expired' | 'revoked' | 'reused' };

export async function rotateRefreshToken(
  sql: postgres.Sql,
  env: Env,
  raw: string,
): Promise<RotateRefreshResult> {
  return sql.begin<RotateRefreshResult>(async (tx) => {
    const row = (await tx<{
      id: number; client_id: string; user_id: string | null; scopes: OAuthScope[];
      family_id: string; revoked_at: Date | null; expired: boolean;
      user_active: boolean | null; user_role: string | null;
    }[]>`
      SELECT rt.id, rt.client_id, rt.user_id, rt.scopes, rt.family_id, rt.revoked_at,
             (rt.expires_at <= NOW()) AS expired,
             u.active AS user_active, u.role AS user_role
      FROM oauth_refresh_tokens rt
      LEFT JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = ${sha256hex(raw)}
      FOR UPDATE OF rt
      LIMIT 1
    `)[0];
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.revoked_at) {
      // Token-theft signal: someone replayed an already-rotated token.
      await revokeRefreshFamily(tx, row.family_id, 'reuse');
      return { ok: false, reason: 'reused' };
    }
    if (row.expired) return { ok: false, reason: 'expired' };
    // Liveness: a deactivated (or deleted) user must not keep minting access
    // tokens via rotation — kill the family so the grant dies with the account.
    if (row.user_id && !row.user_active) {
      await revokeRefreshFamily(tx, row.family_id, 'manual');
      return { ok: false, reason: 'revoked' };
    }
    // Re-derive write scopes from the live role so a demoted manager's grant
    // narrows on the next rotation instead of living on as originally consented.
    const scopes = row.user_id
      ? (dropWriteUnlessManager(row.scopes, row.user_role ?? undefined) as OAuthScope[])
      : row.scopes;
    await tx`UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE id = ${row.id}`;
    const next = await issueRefreshToken(tx, env, {
      clientId: row.client_id,
      userId: row.user_id,
      scopes,
      familyId: row.family_id,
      parentId: row.id,
    });
    return {
      ok: true, raw: next.raw, clientId: row.client_id, userId: row.user_id,
      scopes, familyId: row.family_id,
    };
  });
}

export type RevokeReason = 'reuse' | 'manual' | 'client_revoked';

export async function revokeRefreshFamily(
  sql: AnySql,
  familyId: string,
  reason: RevokeReason = 'manual',
): Promise<void> {
  await sql`
    UPDATE oauth_refresh_tokens SET revoked_at = NOW()
    WHERE family_id = ${familyId} AND revoked_at IS NULL
  `;
  oauthRefreshRevocationsTotal.inc({ reason });
}

// Kill every OAuth grant a user holds. Offboarding and password resets must
// close this path too — revoking only the cookie refresh_tokens would leave
// MCP/API access alive indefinitely through rotation.
export async function revokeUserOAuthTokens(sql: AnySql, userId: string): Promise<void> {
  await sql`
    UPDATE oauth_refresh_tokens SET revoked_at = NOW()
    WHERE user_id = ${userId} AND revoked_at IS NULL
  `;
  oauthRefreshRevocationsTotal.inc({ reason: 'manual' });
}
