import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';

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

describe('/oauth/authorize', () => {
  async function aClient() {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    return createOAuthClient(sql, {
      name: 'authz', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
  }

  it('400s on missing client_id', async () => {
    const r = await api('GET', '/oauth/authorize?response_type=code');
    expect(r.status).toBe(400);
  });

  it('400s on unknown client_id', async () => {
    const r = await api('GET', '/oauth/authorize?response_type=code&client_id=ghost&redirect_uri=https://x/cb&code_challenge=abc&code_challenge_method=S256');
    expect(r.status).toBe(400);
  });

  it('400s on redirect_uri not in allowlist', async () => {
    const c = await aClient();
    const r = await api('GET', `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://attacker/cb&code_challenge=ch&code_challenge_method=S256`);
    expect(r.status).toBe(400);
  });

  it('302s to /login when no auth cookie', async () => {
    const c = await aClient();
    const r = await api('GET', `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=ch&code_challenge_method=S256&scope=market:read&state=s1`);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/login\?next=/);
  });

  it('renders the consent page when logged in (302 to /authorize?...)', async () => {
    const c = await aClient();
    const { token } = await loginAs(ALEX);
    const r = await api('GET', `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=ch&code_challenge_method=S256&scope=market:read&state=s1`, {
      token,
    });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toMatch(/^\/authorize\?req=/);
  });
});

describe('/oauth/authorize/consent', () => {
  it('issues a code and 302s to redirect_uri with code + state', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'consent', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const { token } = await loginAs(ALEX);
    // Park the consent request via /authorize.
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=ch&code_challenge_method=S256&scope=market:read&state=s1`,
      { token },
    );
    expect(start.status).toBe(302);
    const startLoc = start.headers.get('location') ?? '';
    const req = new URL(startLoc, 'http://localhost').searchParams.get('req');
    expect(req).toBeTruthy();
    // Approve.
    const r = await api('POST', '/oauth/authorize/consent', {
      body: { req },
      token,
    });
    expect(r.status).toBe(302);
    const loc = r.headers.get('location') ?? '';
    expect(loc.startsWith('https://example.com/cb')).toBe(true);
    expect(loc).toMatch(/[?&]code=/);
    expect(loc).toMatch(/[?&]state=s1\b/);
  });
});
