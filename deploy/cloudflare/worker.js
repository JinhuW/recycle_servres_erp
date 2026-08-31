// Same-origin edge: serve the SPA and reverse-proxy the backend's API/OAuth
// surfaces to Railway. The browser only ever talks to this Worker, so the
// backend's SameSite=Lax cookies and X-Requested-By CSRF header keep working
// with no backend changes.
const API_PREFIXES = ['/api', '/oauth', '/.well-known'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Force https before anything else. Cloudflare accepts plain-http hits and
    // hands them to the Worker as-is; the backend's auth cookies are marked
    // Secure, so a session established over http can never be stored — login
    // returns 200 and every request after it 401s (2026-08-22 mobile login
    // bounce). 308 preserves the method for the rare non-GET that lands here.
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 308);
    }
    const isApi = API_PREFIXES.some(
      (p) => url.pathname === p || url.pathname.startsWith(p + '/'),
    );
    if (!isApi) {
      // Static asset or SPA route (index.html fallback per not_found_handling).
      return env.ASSETS.fetch(request);
    }
    const backend = env.BACKEND_URL.replace(/\/$/, '');
    const target = backend + url.pathname + url.search;
    // new Request(target, request) copies method, headers (Cookie,
    // X-Requested-By, Content-Type) and body. redirect:'manual' lets OAuth
    // 3xx pass through to the browser unchanged.
    const proxied = new Request(target, request);
    // Prove this request came from the Worker so the backend can refuse direct
    // hits to its public Railway origin. PROXY_SECRET is a Worker secret; when
    // it's unset the backend gate is off, so this header is simply omitted.
    if (env.PROXY_SECRET) proxied.headers.set('X-Proxy-Secret', env.PROXY_SECRET);
    // Preserve the hostname the user actually reached us on. `new Request(target,
    // request)` rewrites Host to the Railway origin, so without this the backend
    // cannot tell which of our custom domains was used and its OAuth discovery
    // documents advertise whichever origin happens to sit first in
    // CORS_ALLOWED_ORIGINS — breaking the RFC 8414 issuer and RFC 9728 resource
    // for every other domain. `set` (not `append`) overwrites anything a caller
    // sent, and the backend still only ever emits an allowlisted origin.
    // X-Public-Host, not X-Forwarded-Host: Railway's edge rewrites the standard
    // X-Forwarded-* headers to its own hostname before the backend sees them,
    // so a value set here never survives. A private header passes through
    // untouched. Both are sent — the standard one for anything downstream that
    // reads it, the private one because it's the only one that arrives intact.
    proxied.headers.set('X-Public-Host', url.host);
    proxied.headers.set('X-Public-Proto', url.protocol.replace(':', ''));
    proxied.headers.set('X-Forwarded-Host', url.host);
    proxied.headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
    // Without this the backend sees the Worker as the peer and records a null IP
    // for every login attempt and DCR registration it tries to rate-limit.
    const clientIp = request.headers.get('CF-Connecting-IP');
    if (clientIp) proxied.headers.set('X-Forwarded-For', clientIp);
    return fetch(proxied, { redirect: 'manual' });
  },
};
