import type { Context, Next } from 'hono';

// Same-site SPA defense-in-depth: every state-changing request must carry a
// header the browser will not attach cross-site without a CORS preflight the
// API does not grant. Safe methods, the health probe, the public
// (unauthenticated, externally-called) vendor endpoints, the OAuth surfaces,
// and the MCP JSON-RPC endpoint are exempt. Most OAuth routes (/token,
// /revoke, /register, discovery) are not cookie-auth'd at all. The one
// exception is /oauth/authorize/consent, which IS cookie-auth'd — but a
// forged POST still fails because the server-issued `req` handle is
// single-use, time-limited, and bound to user_id_from_cookie (enforced in
// the consent transaction). SameSite=Lax on the auth cookie is additional
// defense in depth.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
function exempt(path: string): boolean {
  return path === '/api/health'
    || path === '/api/mcp'
    || path === '/api/market/values'
    || path.startsWith('/api/public/')
    || path.startsWith('/oauth/')
    || path.startsWith('/.well-known/');
}
export async function csrfGuard(c: Context, next: Next) {
  if (SAFE.has(c.req.method)) return next();
  if (exempt(c.req.path)) return next();
  if (c.req.header('X-Requested-By') !== 'recycle-erp') {
    return c.json({ error: 'CSRF check failed' }, 403);
  }
  return next();
}
