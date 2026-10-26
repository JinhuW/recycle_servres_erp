import type { Context, Next } from 'hono';

// Same-site SPA defense-in-depth: every state-changing request must carry a
// header the browser will not attach cross-site without a CORS preflight the
// API does not grant. Safe methods, the health probe, the public
// (unauthenticated, externally-called) website forms and Shippo webhook, the two scraper push surfaces (Bearer-only), the OAuth surfaces,
// and the MCP JSON-RPC endpoint are exempt. Most OAuth routes (/token,
// /revoke, /register, discovery) are not cookie-auth'd at all. The one
// exception is /oauth/authorize/consent, which IS cookie-auth'd — but a
// forged POST still fails because the server-issued `req` handle is
// single-use, time-limited, and bound to user_id_from_cookie (enforced in
// the consent transaction). SameSite=Lax on the auth cookie is additional
// defense in depth.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// The fleet's bearer-only surfaces: worker containers and host agents post
// here with no cookie, so there is nothing to forge. The manager's own host
// routes (PUT/DELETE /api/fleet/hosts/:id) stay guarded.
const FLEET_HOST_REPORT = /^\/api\/fleet\/hosts\/[^/]+\/(report|stopped)$/;
function exempt(path: string): boolean {
  return path === '/api/health'
    || path.startsWith('/api/fleet/worker/')
    || FLEET_HOST_REPORT.test(path)
    || path === '/api/mcp'
    || path === '/api/market/values'
    || path.startsWith('/api/wechat-market/push/')
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
