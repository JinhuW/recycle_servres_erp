import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type postgres from 'postgres';
import { revokeRefreshFamily } from './tokens';

export type OAuthClientRow = {
  id: string;
  secret_hash: string | null;
  name: string;
  redirect_uris: string[];
  grant_types: string[];
  scopes: string[];
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
};

type AnySql = postgres.Sql | postgres.TransactionSql;

const newClientId = () => randomBytes(16).toString('hex');                  // 32 hex chars
const newClientSecret = () => randomBytes(32).toString('base64url');        // ~43 chars

export type CreateClientInput = {
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  scopes: string[];
  createdBy: string | null;
  public: boolean;
};

export async function createOAuthClient(
  sql: AnySql,
  input: CreateClientInput,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const id = newClientId();
  const secret = input.public ? null : newClientSecret();
  const hash = secret ? await bcrypt.hash(secret, 10) : null;
  await sql`
    INSERT INTO oauth_clients
      (id, secret_hash, name, redirect_uris, grant_types, scopes, created_by)
    VALUES
      (${id}, ${hash}, ${input.name}, ${input.redirectUris},
       ${input.grantTypes}, ${input.scopes}, ${input.createdBy})
  `;
  return { clientId: id, clientSecret: secret };
}

export async function findOAuthClient(
  sql: AnySql,
  clientId: string,
): Promise<OAuthClientRow | null> {
  const rows = await sql<OAuthClientRow[]>`
    SELECT * FROM oauth_clients WHERE id = ${clientId} AND revoked_at IS NULL LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function verifyClientSecret(
  row: OAuthClientRow,
  presented: string,
): Promise<boolean> {
  if (!row.secret_hash) return false;
  return bcrypt.compare(presented, row.secret_hash);
}

export async function listOAuthClients(sql: AnySql): Promise<OAuthClientRow[]> {
  return sql<OAuthClientRow[]>`
    SELECT * FROM oauth_clients WHERE revoked_at IS NULL ORDER BY created_at DESC
  `;
}

export async function revokeOAuthClient(sql: AnySql, clientId: string): Promise<void> {
  await sql`
    UPDATE oauth_clients SET revoked_at = NOW() WHERE id = ${clientId} AND revoked_at IS NULL
  `;
  // Cascade revoke any live refresh-token families. Routing through
  // revokeRefreshFamily(reason='client_revoked') keeps the
  // oauth_refresh_revocations_total counter labelled correctly.
  const families = await sql<{ family_id: string }[]>`
    SELECT DISTINCT family_id FROM oauth_refresh_tokens
    WHERE client_id = ${clientId} AND revoked_at IS NULL
  `;
  for (const f of families) {
    await revokeRefreshFamily(sql, f.family_id, 'client_revoked');
  }
}
