import type { MiddlewareHandler } from 'hono';
import { getDb } from '../db';
import { verifyAccessToken } from './tokens';
import { resolvePublicOrigin } from './metadata';
import { addLogContext } from '../lib/log';
import type { Env, OAuthCtx, OAuthScope } from '../types';

// RFC 6750 bearer-token middleware. 401 (with WWW-Authenticate pointing at
// the protected-resource metadata) when the token is missing or invalid;
// 403 (insufficient_scope) when it's valid but lacks a required scope.
export function bearerGuard(opts: { scopes: OAuthScope[] }): MiddlewareHandler<{
  Bindings: Env;
  Variables: { oauthCtx: OAuthCtx };
}> {
  return async (c, next) => {
    const wwwAuth = () =>
      `Bearer realm="recycle-erp", error="invalid_token", resource_metadata="${resolvePublicOrigin(c)}/.well-known/oauth-protected-resource"`;
    const env = c.env;
    const header = c.req.header('authorization') ?? '';
    if (!header.toLowerCase().startsWith('bearer ')) {
      c.header('WWW-Authenticate', wwwAuth());
      return c.json({ error: 'invalid_token' }, 401);
    }
    const token = header.slice(7).trim();
    const claims = await verifyAccessToken(env, token);
    if (!claims) {
      c.header('WWW-Authenticate', wwwAuth());
      return c.json({ error: 'invalid_token' }, 401);
    }
    // A signature only proves the token was issued. Revoking the client,
    // deactivating the user or changing their password has to end it too,
    // rather than leaving it working until it expires. client_credentials
    // tokens carry no user, so only the client is checked for those.
    const sql = getDb(env);
    const userLive = claims.sub
      ? sql`AND EXISTS (
          SELECT 1 FROM users u
          WHERE u.id = ${claims.sub} AND u.active
            AND (u.tokens_valid_after IS NULL
                 OR to_timestamp(${claims.iat}) >= u.tokens_valid_after))`
      : sql``;
    const live = await sql`
      SELECT 1 FROM oauth_clients
      WHERE id = ${claims.cid} AND revoked_at IS NULL ${userLive}
      LIMIT 1
    `;
    if (live.length === 0) {
      c.header('WWW-Authenticate', wwwAuth());
      return c.json({ error: 'invalid_token' }, 401);
    }
    for (const need of opts.scopes) {
      if (!claims.scopes.includes(need)) {
        return c.json({ error: 'insufficient_scope', scope: opts.scopes.join(' ') }, 403);
      }
    }
    c.set('oauthCtx', {
      clientId: claims.cid, userId: claims.sub, scopes: claims.scopes, jti: claims.jti,
    });
    addLogContext({ userId: claims.sub, oauthClientId: claims.cid });
    await next();
  };
}
