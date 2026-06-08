import type { Env } from '../types';

// Structural shape of the bits of a Hono Context this reads. Typing it this way
// (rather than Context<{ Bindings: Env }>) sidesteps Hono's invariant Variables
// generic, so callers with any Variables shape can pass their context through.
type OriginCtx = { env: Env; req: { header(name: string): string | undefined } };

const SCOPES = ['market:read', 'market:write', 'sellorder:read', 'sellorder:write'] as const;

const hostOf = (host: string) => host.split(':')[0];
const isLoopback = (host: string) => {
  const h = hostOf(host);
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
};

const stripSlash = (s: string) => s.replace(/\/+$/, '');
const parseOrigins = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((s) => stripSlash(s.trim())).filter(Boolean);
const nonLoopbackExplicit = (explicit: string | undefined): string | undefined => {
  if (!explicit) return undefined;
  try { return isLoopback(new URL(explicit).host) ? undefined : explicit; }
  catch { return undefined; }
};

// The OAuth issuer identifier — the public origin MCP clients are handed for
// discovery (authorize/token/register endpoints + the protected resource).
//
// Never emit a host taken straight from request headers: that would let a
// caller poison their own discovery document (or, with a trusted-proxy misstep,
// others') via Host / X-Forwarded-Host injection. CORS_ALLOWED_ORIGINS is
// required in production and already enumerates the origins this server answers
// for, so it doubles as the issuer allowlist — when set, we only ever return an
// origin from it (preferring the one the request targeted, for multi-domain
// deploys). The request-derived path is reachable only in dev, where no
// allowlist is configured and the loopback .env.example issuer would otherwise
// mis-advertise localhost.
export function resolvePublicOrigin(c: OriginCtx): string {
  const explicit = stripSlash(c.env.OAUTH_ISSUER_URL?.trim() ?? '') || undefined;
  const explicitOk = nonLoopbackExplicit(explicit);
  const allow = parseOrigins(c.env.CORS_ALLOWED_ORIGINS);

  const fwdHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const host = fwdHost || c.req.header('host');
  let candidate: string | undefined;
  if (host) {
    const fwdProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
    const proto = fwdProto || (isLoopback(host) ? 'http' : 'https');
    candidate = `${proto}://${host}`;
  }

  if (allow.length > 0) {
    // Locked down: only ever hand back an allowlisted origin.
    if (candidate && allow.includes(candidate)) return candidate;
    if (explicitOk && allow.includes(explicitOk)) return explicitOk;
    return allow[0];
  }

  // No allowlist (dev only): honour an explicit non-loopback issuer, else the
  // request-derived origin, else the configured/loopback fallback.
  return explicitOk ?? candidate ?? explicit ?? 'http://localhost:8787';
}

export function authorizationServerMetadata(iss: string) {
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
    scopes_supported: [...SCOPES],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_signing_alg_values_supported: ['EdDSA'],
  };
}

export function protectedResourceMetadata(iss: string) {
  return {
    resource: `${iss}/api/mcp`,
    authorization_servers: [iss],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
  };
}
