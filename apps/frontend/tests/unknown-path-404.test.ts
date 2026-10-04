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
      return new Response('', { status: 404 });
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

  it('keeps a missing hashed asset a plain 404', async () => {
    const res = await get('/assets/gone-abc123.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/plain');
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
    for (const p of ['/vnc/homelab-1', '/fleet', '/inventory/x', '/submitx', '/authorize2']) {
      expect(allowed(p)).toBe(false);
    }
  });
});
