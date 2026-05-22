import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb } from './helpers/db';
import { api } from './helpers/app';

describe('OAuth discovery', () => {
  beforeAll(async () => { await resetDb(); });

  it('GET /.well-known/oauth-authorization-server returns RFC 8414 metadata', async () => {
    const r = await api('GET', '/.well-known/oauth-authorization-server');
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.issuer).toBe('string');
    expect(body.issuer).toBe('http://localhost:8787');
    expect(body.response_types_supported).toEqual(['code']);
    expect(body.token_endpoint_auth_signing_alg_values_supported).toEqual(['EdDSA']);
    expect(body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(body.revocation_endpoint).toMatch(/\/oauth\/revoke$/);
    expect((body.scopes_supported as string[])).toEqual(expect.arrayContaining(['market:read','market:write']));
    expect((body.grant_types_supported as string[])).toEqual(expect.arrayContaining(['authorization_code','refresh_token','client_credentials']));
    expect((body.code_challenge_methods_supported as string[])).toEqual(['S256']);
  });

  it('GET /.well-known/oauth-protected-resource points to the AS', async () => {
    const r = await api('GET', '/.well-known/oauth-protected-resource');
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect((body.authorization_servers as string[])[0]).toMatch(/^https?:\/\//);
    expect((body.scopes_supported as string[])).toEqual(expect.arrayContaining(['market:read','market:write']));
  });
});

describe('DCR /oauth/register', () => {
  it('rejects DCR by default (OAUTH_DCR_OPEN=false)', async () => {
    const r = await api('POST', '/oauth/register', {
      body: { client_name: 'x', redirect_uris: ['https://example.com/cb'] },
    });
    expect(r.status).toBe(403);
  });

  it('with OAUTH_DCR_OPEN=true, registers and returns client_id + secret', async () => {
    const prev = process.env.OAUTH_DCR_OPEN;
    process.env.OAUTH_DCR_OPEN = 'true';
    try {
      const r = await api('POST', '/oauth/register', {
        body: {
          client_name: 'claude-ai connector',
          redirect_uris: ['https://claude.ai/oauth/callback'],
          grant_types: ['authorization_code','refresh_token'],
          scope: 'market:read',
        },
      });
      expect(r.status).toBe(201);
      const body = r.body as Record<string, unknown>;
      expect(typeof body.client_id).toBe('string');
      expect(typeof body.client_secret).toBe('string');
      expect((body.redirect_uris as string[])[0]).toBe('https://claude.ai/oauth/callback');
    } finally {
      process.env.OAUTH_DCR_OPEN = prev;
    }
  });

  it('rejects non-https + non-localhost redirect URIs', async () => {
    const prev = process.env.OAUTH_DCR_OPEN;
    process.env.OAUTH_DCR_OPEN = 'true';
    try {
      const r = await api('POST', '/oauth/register', {
        body: { client_name: 'evil', redirect_uris: ['http://evil.example.com/cb'] },
      });
      expect(r.status).toBe(400);
    } finally {
      process.env.OAUTH_DCR_OPEN = prev;
    }
  });
});
