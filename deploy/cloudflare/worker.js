// Same-origin edge: serve the SPA and reverse-proxy the backend's API/OAuth
// surfaces to Railway. The browser only ever talks to this Worker, so the
// backend's SameSite=Lax cookies and X-Requested-By CSRF header keep working
// with no backend changes.
const API_PREFIXES = ['/api', '/oauth', '/.well-known'];
// Content-hashed by the build, and cached `immutable` for a year by
// public/_headers. A miss under these is never a page the user typed — it is a
// chunk from a build that has since been replaced — so it must 404 rather than
// fall back to index.html.
const HASHED_PREFIXES = ['/assets/', '/fonts/', '/icons/'];

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
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
      // wrangler.toml sets not_found_handling = "none", so the SPA fallback is
      // ours to serve — and ours to withhold. A hashed asset that is gone stays
      // gone: answering it with index.html hands the browser a document where
      // it asked for a module, and the /assets/* rule in public/_headers would
      // then cache that answer as immutable for a year (RS-017).
      //
      // Defensive rather than load-bearing: these three prefixes are excluded
      // from run_worker_first, so in practice Cloudflare's asset layer returns
      // the 404 itself and this branch never runs. It is here so that the
      // fallback below can never claim a path that is plainly a build artifact,
      // whichever layer ends up answering.
      if (HASHED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
        return new Response('Not found', {
          status: 404,
          headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' },
        });
      }
      // Every other path is a client-side route — the app is hash-routed, so in
      // practice `/`, the vendor and seller portals (/v/, /s/), /authorize, and
      // the PWA manifest shortcuts. Same bytes index.html always served, with
      // the no-cache it carries in _headers, which does not apply to a response
      // built here.
      // A plain GET, not a copy of `request`: /share-target arrives as a POST
      // (the manifest's share target, normally intercepted by the service
      // worker) and the asset binding would answer a POST with 405.
      const index = await env.ASSETS.fetch(new URL('/index.html', url));
      // Copy into a Headers and `set`, rather than spreading into an object
      // literal: header names arrive lowercased, so a 'Cache-Control' key would
      // sit alongside the binding's 'cache-control' and the two would be joined
      // into one comma-separated value instead of one replacing the other.
      const headers = new Headers(index.headers);
      headers.set('Cache-Control', 'no-cache');
      return new Response(index.body, { status: 200, headers });
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
