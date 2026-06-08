import type { MiddlewareHandler } from 'hono';
import { verifyAccessToken } from './tokens';
import { resolvePublicOrigin } from './metadata';
import type { Env, OAuthCtx, OAuthScope } from '../types';

// RFC 6750 bearer-token middleware. 401 (with WWW-Authenticate pointing at
// the protected-resource metadata) when the token is missing or invalid;
// 403 (insufficient_scope) when it's valid but lacks a required scope.
export function bearerGuard(opts: { scopes: OAuthScope[] }): MiddlewareHandler<{
  Bindings: Env;
  Variables: { oauthCtx: OAuthCtx };
}> {
  return async (c, next) => {
    const env = c.env;
    const wwwAuth = `Bearer realm="recycle-erp", error="invalid_token", resource_metadata="${resolvePublicOrigin(c)}/.well-known/oauth-protected-resource"`;
    const header = c.req.header('authorization') ?? '';
    if (!header.toLowerCase().startsWith('bearer ')) {
      c.header('WWW-Authenticate', wwwAuth);
      return c.json({ error: 'invalid_token' }, 401);
    }
    const token = header.slice(7).trim();
    const claims = await verifyAccessToken(env, token);
    if (!claims) {
      c.header('WWW-Authenticate', wwwAuth);
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
    await next();
  };
}
