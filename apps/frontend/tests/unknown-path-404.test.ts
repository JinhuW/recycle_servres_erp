import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain JS Worker module, no types.
import worker from '../../../deploy/cloudflare/worker.js';
import { SHELL_PATHS, shellNavigationAllowlist } from '../src/lib/shellPaths';

// RS-167: the app is hash-routed, so serving index.html for every unknown path
// let `/vnc/homelab-1#/fleet` render Fleet under a URL that does not exist.

const INDEX = '<!doctype html><title>shell</title>';

// The asset binding: index.html and one real static file; everything else is
// the 404 that `not_found_handling = "none"` produces.
const env = {
  BACKEND_URL: 'https://backend.invalid',
  ASSETS: {
    async fetch(input: Request | URL) {
      const { pathname } = new URL(input instanceof Request ? input.url : input);
      if (pathname === '/index.html') return new Response(INDEX, { headers: { 'content-type': 'text/html' } });
      if (pathname === '/sw.js') return new Response('sw', { headers: { 'content-type': 'text/javascript' } });
      if (pathname === '/assets/index-abc123.js') {
        return new Response('chunk', {
          headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=31536000, immutable' },
        });
      }
      // What the asset layer really sends for a miss: `_headers` stamps the
      // prefix's caching rule on the 404 too.
      return new Response('', {
        status: 404,
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
      });
    },
  },
};

const get = (path: string) => worker.fetch(new Request(`https://inventory.example${path}`), env) as Promise<Response>;

describe('Worker document fallback', () => {
  it.each(SHELL_PATHS)('serves the shell at %s', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
  });

  it('keeps the query on a shell path (OAuth consent)', async () => {
    expect((await get('/authorize?req=abc')).status).toBe(200);
  });

  it('serves the shell at the OAuth sign-in bounce', async () => {
    const res = await get('/login?next=%2Foauth%2Fauthorize%3Fclient_id%3Dx');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX);
  });

  it.each(['/vnc/homelab-1', '/fleet', '/asdf/qwe', '/inventory/', '/v/sometoken'])(
    '404s an unknown path %s with a page',
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(await res.text()).toContain('Page not found');
    },
  );

  it('still serves real static files', async () => {
    const res = await get('/sw.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('sw');
  });

  it('passes a real hashed asset through with its own headers', async () => {
    const res = await get('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('chunk');
  });

  // RS-221: a deploy rolls out across the edge unevenly, so a page from the
  // new build can ask for its own chunk before the node it reaches has it. A
  // miss that carried the immutable rule stayed broken in that browser for a
  // year, deploy finished or not.
  it.each(['/assets/gone-abc123.js', '/fonts/gone.woff2', '/icons/gone.png'])(
    'keeps a missing static file a plain, uncacheable 404: %s',
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('text/plain');
      expect(res.headers.get('cache-control')).toBe('no-store');
    },
  );
});

// The test above runs the Worker directly, so it says nothing about whether
// Cloudflare ever hands it the request. A `!/assets/*` entry in
// run_worker_first sends a miss straight to the asset layer, which 404s it
// with the immutable header — the RS-221 outage, with every test still green.
describe('wrangler.toml', () => {
  const toml = readFileSync(new URL('../../../deploy/cloudflare/wrangler.toml', import.meta.url), 'utf8')
    .replace(/#.*$/gm, '');

  it('runs the Worker first for every path', () => {
    expect(toml).toMatch(/^\s*run_worker_first\s*=\s*true\s*$/m);
    expect(toml).not.toMatch(/"!\//);
  });
});

describe('service worker navigation allowlist', () => {
  const allowed = (pathAndSearch: string) => shellNavigationAllowlist().some((re) => re.test(pathAndSearch));

  it('matches every shell path, with or without a query', () => {
    for (const p of SHELL_PATHS) {
      expect(allowed(p)).toBe(true);
      expect(allowed(`${p}?x=1`)).toBe(true);
    }
  });

  it('does not match unknown paths, so they reach the Worker 404', () => {
    for (const p of ['/vnc/homelab-1', '/fleet', '/inventory/x', '/submitx', '/authorize2', '/login/x']) {
      expect(allowed(p)).toBe(false);
    }
  });
});
