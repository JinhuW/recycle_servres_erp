import { describe, it, expect } from 'vitest';
import { api } from './helpers/app';

// Regression: with credentials:true the old config reflected ANY origin,
// letting any site make credentialed calls. CORS_ALLOWED_ORIGINS now gates it.
describe('CORS allowlist', () => {
  const ALLOW = 'https://app.example.com';

  it('reflects an allowed origin when CORS_ALLOWED_ORIGINS is set', async () => {
    const r = await api('GET', '/', {
      env: { CORS_ALLOWED_ORIGINS: ALLOW },
      headers: { Origin: ALLOW },
    });
    expect(r.headers.get('access-control-allow-origin')).toBe(ALLOW);
  });

  it('denies an origin outside the allowlist', async () => {
    const r = await api('GET', '/', {
      env: { CORS_ALLOWED_ORIGINS: ALLOW },
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(r.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
  });

  it('stays permissive for localhost in dev when the allowlist is unset', async () => {
    const r = await api('GET', '/', { headers: { Origin: 'http://localhost:5173' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('allows a 127.0.0.1 dev origin when the allowlist is unset', async () => {
    const r = await api('GET', '/', { headers: { Origin: 'http://127.0.0.1:4173' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4173');
  });

  it('does NOT reflect an arbitrary remote origin when the allowlist is unset (fail-closed)', async () => {
    const r = await api('GET', '/', { headers: { Origin: 'https://evil.example.com' } });
    const acao = r.headers.get('access-control-allow-origin');
    expect(acao).not.toBe('https://evil.example.com');
    expect(acao).not.toBe('*');
  });
});

describe('CORS headers for MCP clients', () => {
  it('allows the Streamable HTTP transport headers on preflight', async () => {
    const r = await api('OPTIONS', '/api/mcp', {
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'mcp-protocol-version',
      },
    });
    expect((r.headers.get('access-control-allow-headers') ?? '').toLowerCase())
      .toContain('mcp-protocol-version');
  });

  it('exposes WWW-Authenticate so a browser client can find the AS', async () => {
    const r = await api('POST', '/api/mcp', {
      headers: { Origin: 'http://localhost:5173' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize' },
    });
    expect(r.status).toBe(401);
    expect((r.headers.get('access-control-expose-headers') ?? '').toLowerCase())
      .toContain('www-authenticate');
  });
});
