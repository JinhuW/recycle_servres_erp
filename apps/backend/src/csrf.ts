import type { Context, Next } from 'hono';

// Same-site SPA defense-in-depth: every state-changing request must carry a
// header the browser will not attach cross-site without a CORS preflight the
// API does not grant. Safe methods, the health probe, and the public
// (unauthenticated, externally-called) vendor endpoints are exempt — CSRF is
// a cookie-confused-deputy attack and those routes are not cookie-auth'd.
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
function exempt(path: string): boolean {
  return path === '/api/health' || path.startsWith('/api/public/');
}
export async function csrfGuard(c: Context, next: Next) {
  if (SAFE.has(c.req.method)) return next();
  if (exempt(c.req.path)) return next();
  if (c.req.header('X-Requested-By') !== 'recycle-erp') {
    return c.json({ error: 'CSRF check failed' }, 403);
  }
  return next();
}
