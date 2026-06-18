// Same-origin edge: serve the SPA and reverse-proxy the backend's API/OAuth
// surfaces to Railway. The browser only ever talks to this Worker, so the
// backend's SameSite=Lax cookies and X-Requested-By CSRF header keep working
// with no backend changes.
const API_PREFIXES = ['/api', '/oauth', '/.well-known'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
    return fetch(new Request(target, request), { redirect: 'manual' });
  },
};
