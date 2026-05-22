import type { Context, Next } from 'hono';

// Same-site SPA defense-in-depth: every state-changing request must carry a
// header the browser will not attach cross-site without a CORS preflight the
// API does not grant. Safe methods, the health probe, the public
// (unauthenticated, externally-called) vendor endpoints, the OAuth surfaces,
// and the MCP JSON-RPC endpoint are exempt — CSRF is a cookie-confused-deputy
// attack and those routes are not cookie-auth'd (OAuth /token, /revoke,
// /register, and the discovery docs use client credentials or are public
// metadata; /api/mcp uses Bearer tokens).
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
