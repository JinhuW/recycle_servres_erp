import type { Env } from '../types';

const SCOPES = ['market:read', 'market:write'] as const;

export function authorizationServerMetadata(env: Env) {
  const iss = env.OAUTH_ISSUER_URL ?? '';
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    registration_endpoint: `${iss}/oauth/register`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: SCOPES,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_signing_alg_values_supported: ['EdDSA'],
  };
}

export function protectedResourceMetadata(env: Env) {
  const iss = env.OAUTH_ISSUER_URL ?? '';
  return {
    resource: `${iss}/api/mcp`,
    authorization_servers: [iss],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
  };
}
