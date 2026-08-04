import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api } from './helpers/app';
import { loginAs, ALEX, MARCUS } from './helpers/auth';
import { generateVerifier, challengeS256 } from '../src/oauth/pkce';

describe('OAuth discovery', () => {
  beforeAll(async () => { await resetDb(); });

  it('GET /.well-known/oauth-authorization-server returns RFC 8414 metadata', async () => {
    const r = await api('GET', '/.well-known/oauth-authorization-server');
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.issuer).toBe('string');
    // No Host/X-Forwarded-Host on this in-memory request, so the resolver falls
    // back to the configured origin. Real HTTP (and the proxied case below)
    // always carries a Host. See the X-Forwarded-Host test for the derived path.
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

  it('derives the issuer from the proxied Host (not the loopback env)', async () => {
    const r = await api('GET', '/.well-known/oauth-authorization-server', {
      headers: {
        'X-Forwarded-Host': 'inventory.recycleservers.com',
        'X-Forwarded-Proto': 'https',
      },
    });
    const body = r.body as Record<string, unknown>;
    expect(body.issuer).toBe('https://inventory.recycleservers.com');
    expect(body.authorization_endpoint).toBe('https://inventory.recycleservers.com/oauth/authorize');
    expect((body.token_endpoint as string)).toBe('https://inventory.recycleservers.com/oauth/token');
  });

  it('advertises the sell-order scopes in AS metadata', async () => {
    const r = await api('GET', '/.well-known/oauth-authorization-server');
    expect(r.status).toBe(200);
    const scopes = (r.body as any).scopes_supported as string[];
    expect(scopes).toContain('sellorder:read');
    expect(scopes).toContain('sellorder:write');
    expect(scopes).toContain('market:read'); // unchanged
  });

  it('serves the RFC 9728 path-suffixed protected-resource document', async () => {
    // Clients probe /.well-known/oauth-protected-resource/api/mcp first and only
    // some fall back to the bare path.
    const r = await api('GET', '/.well-known/oauth-protected-resource/api/mcp', {
      headers: { 'X-Forwarded-Host': 'inventory.recycleservers.com', 'X-Forwarded-Proto': 'https' },
    });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(body.resource).toBe('https://inventory.recycleservers.com/api/mcp');
    expect((body.authorization_servers as string[])[0]).toBe('https://inventory.recycleservers.com');
    expect(body.resource_name).toBe('Recycle Servers ERP');
  });

  it('serves the path-suffixed AS document with the same issuer as the bare one', async () => {
    const suffixed = await api('GET', '/.well-known/oauth-authorization-server/api/mcp');
    const bare = await api('GET', '/.well-known/oauth-authorization-server');
    expect(suffixed.status).toBe(200);
    expect((suffixed.body as Record<string, unknown>).issuer)
      .toBe((bare.body as Record<string, unknown>).issuer);
  });

  it('prefers X-Public-Host, which survives the Railway edge', async () => {
    // Railway rewrites X-Forwarded-Host to its own hostname, so the Worker's
    // value only arrives in the private header. Trusting the standard one alone
    // shipped a prod issuer pointing at the wrong domain.
    const r = await api('GET', '/.well-known/oauth-authorization-server', {
      env: {
        CORS_ALLOWED_ORIGINS:
          'https://inventory-prod.recycleservers.com,https://inventory.recycleservers.com',
      },
      headers: {
        'X-Public-Host': 'inventory.recycleservers.com',
        'X-Public-Proto': 'https',
        'X-Forwarded-Host': 'backend-production-7b10.up.railway.app',
        'X-Forwarded-Proto': 'https',
      },
    });
    expect((r.body as Record<string, unknown>).issuer)
      .toBe('https://inventory.recycleservers.com');
  });

  it('still refuses a non-allowlisted X-Public-Host', async () => {
    const r = await api('GET', '/.well-known/oauth-authorization-server', {
      env: { CORS_ALLOWED_ORIGINS: 'https://inventory.recycleservers.com' },
      headers: { 'X-Public-Host': 'evil.example.com', 'X-Public-Proto': 'https' },
    });
    expect((r.body as Record<string, unknown>).issuer)
      .toBe('https://inventory.recycleservers.com');
  });

  it('prefers the requested host over the first allowlist entry', async () => {
    // Regression: without X-Forwarded-Host from the edge, the resolver fell
    // through to allow[0] and advertised inventory-prod to callers who had
    // reached us on inventory — breaking the RFC 9728 resource match.
    const r = await api('GET', '/.well-known/oauth-protected-resource', {
      env: {
        CORS_ALLOWED_ORIGINS:
          'https://inventory-prod.recycleservers.com,https://inventory.recycleservers.com',
      },
      headers: { 'X-Forwarded-Host': 'inventory.recycleservers.com', 'X-Forwarded-Proto': 'https' },
    });
    expect((r.body as Record<string, unknown>).resource)
      .toBe('https://inventory.recycleservers.com/api/mcp');
  });

  it('never emits a Host outside CORS_ALLOWED_ORIGINS (injection-proof)', async () => {
    const r = await api('GET', '/.well-known/oauth-authorization-server', {
      env: { CORS_ALLOWED_ORIGINS: 'https://inventory.recycleservers.com' },
      headers: { 'X-Forwarded-Host': 'evil.example.com', 'X-Forwarded-Proto': 'https' },
    });
    // The injected host is not allowlisted, so the resolver falls back to the
    // configured origin rather than advertising the attacker's domain.
    expect((r.body as Record<string, unknown>).issuer).toBe('https://inventory.recycleservers.com');
  });
});

describe('DCR /oauth/register', () => {
  it('registers by default and returns client_id + secret', async () => {
    const r = await api('POST', '/oauth/register', {
      body: {
        client_name: 'claude-ai connector',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['authorization_code','refresh_token'],
        scope: 'market:read',
      },
    });
    expect(r.status).toBe(201);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.client_id).toBe('string');
    expect(typeof body.client_secret).toBe('string');
    expect((body.redirect_uris as string[])[0]).toBe('https://claude.ai/api/mcp/auth_callback');
  });

  it('returns the RFC 7591 §3.2.1 fields a strict registrant requires', async () => {
    const r = await api('POST', '/oauth/register', {
      body: {
        client_name: 'strict',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
      },
    });
    expect(r.status).toBe(201);
    const body = r.body as Record<string, unknown>;
    // REQUIRED alongside a secret; 0 means "never expires".
    expect(body.client_secret_expires_at).toBe(0);
    expect(typeof body.client_id_issued_at).toBe('number');
    expect(body.response_types).toEqual(['code']);
    expect(body.client_name).toBe('strict');
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
  });

  it('honours token_endpoint_auth_method=none (public PKCE client)', async () => {
    const r = await api('POST', '/oauth/register', {
      body: {
        client_name: 'public',
        redirect_uris: ['http://localhost/callback'],
        token_endpoint_auth_method: 'none',
      },
    });
    expect(r.status).toBe(201);
    const body = r.body as Record<string, unknown>;
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.client_secret).toBeUndefined();
    expect(body.client_secret_expires_at).toBeUndefined();
  });

  it('echoes client_secret_post when the client asks for it', async () => {
    const r = await api('POST', '/oauth/register', {
      body: {
        client_name: 'post-auth',
        redirect_uris: ['https://example.com/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    });
    expect((r.body as Record<string, unknown>).token_endpoint_auth_method).toBe('client_secret_post');
  });

  it('defaults an unscoped registration to every advertised scope', async () => {
    // Defaulting to market:read alone made a connector look like it only had
    // two tools, since tools/list filters on granted scopes.
    const r = await api('POST', '/oauth/register', {
      body: { client_name: 'unscoped', redirect_uris: ['https://example.com/cb'] },
    });
    expect(r.status).toBe(201);
    expect(((r.body as Record<string, unknown>).scope as string).split(' ')).toEqual(
      expect.arrayContaining(['market:read', 'market:write', 'sellorder:read', 'sellorder:write']),
    );
  });

  it('rejects DCR when OAUTH_DCR_OPEN=false', async () => {
    const prev = process.env.OAUTH_DCR_OPEN;
    process.env.OAUTH_DCR_OPEN = 'false';
    try {
      const r = await api('POST', '/oauth/register', {
        body: { client_name: 'x', redirect_uris: ['https://example.com/cb'] },
      });
      expect(r.status).toBe(403);
    } finally {
      process.env.OAUTH_DCR_OPEN = prev;
    }
  });

  it('stops advertising registration_endpoint when DCR is off', async () => {
    // A registration_endpoint that 403s makes clients fail hard instead of
    // falling back to a manually-issued client_id.
    const prev = process.env.OAUTH_DCR_OPEN;
    process.env.OAUTH_DCR_OPEN = 'false';
    try {
      const r = await api('GET', '/.well-known/oauth-authorization-server');
      expect((r.body as Record<string, unknown>).registration_endpoint).toBeUndefined();
    } finally {
      process.env.OAUTH_DCR_OPEN = prev;
    }
  });

  it('throttles repeat registrations from one IP', async () => {
    const ip = '203.0.113.77';
    const register = () => api('POST', '/oauth/register', {
      headers: { 'X-Forwarded-For': ip },
      body: { client_name: 'flood', redirect_uris: ['https://example.com/cb'] },
    });
    let last = await register();
    for (let i = 0; i < 12 && last.status === 201; i++) last = await register();
    expect(last.status).toBe(429);
    expect((last.body as Record<string, unknown>).error).toBe('temporarily_unavailable');
  });

  it('rejects non-https + non-localhost redirect URIs', async () => {
    const r = await api('POST', '/oauth/register', {
      body: { client_name: 'evil', redirect_uris: ['http://evil.example.com/cb'] },
    });
    expect(r.status).toBe(400);
  });

  it('rejects a redirect URI carrying a fragment', async () => {
    const r = await api('POST', '/oauth/register', {
      body: { client_name: 'frag', redirect_uris: ['https://example.com/cb#x'] },
    });
    expect(r.status).toBe(400);
  });

  it('keeps market:write when requested (granted only to managers at consent)', async () => {
    const r = await api('POST', '/oauth/register', {
      body: {
        client_name: 'claude-ai write',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['authorization_code','refresh_token'],
        scope: 'market:read market:write',
      },
    });
    expect(r.status).toBe(201);
    expect(((r.body as Record<string, unknown>).scope as string).split(' '))
      .toEqual(expect.arrayContaining(['market:read', 'market:write']));
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

  it('redirects with error=invalid_request when code_challenge is missing', async () => {
    const c = await aClient();
    const r = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&state=s1&scope=market:read`,
    );
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!, 'http://localhost');
    expect(loc.origin + loc.pathname).toBe('https://example.com/cb');
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('s1');
  });

  it('redirects with error=invalid_scope when client lacks requested scope', async () => {
    const c = await aClient();
    const r = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&state=s1&scope=market:write&code_challenge=ch&code_challenge_method=S256`,
    );
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!, 'http://localhost');
    expect(loc.origin + loc.pathname).toBe('https://example.com/cb');
    expect(loc.searchParams.get('error')).toBe('invalid_scope');
    expect(loc.searchParams.get('state')).toBe('s1');
  });

  it('redirects with error=unsupported_response_type when response_type is not code', async () => {
    const c = await aClient();
    const r = await api('GET',
      `/oauth/authorize?response_type=token&client_id=${c.clientId}&redirect_uri=https://example.com/cb&state=s1&scope=market:read&code_challenge=ch&code_challenge_method=S256`,
    );
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!, 'http://localhost');
    expect(loc.origin + loc.pathname).toBe('https://example.com/cb');
    expect(loc.searchParams.get('error')).toBe('unsupported_response_type');
    expect(loc.searchParams.get('state')).toBe('s1');
  });
});

describe('/oauth/authorize loopback redirect matching (RFC 8252 §7.3)', () => {
  // Claude Code binds a fresh port each run, so a portless registration has to
  // match whatever port shows up at authorize time.
  const mkClient = async (redirectUris: string[]) => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    return createOAuthClient(sql, {
      name: 'loopback', redirectUris,
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
  };
  const authorize = async (clientId: string, redirectUri: string) => {
    const { token } = await loginAs(ALEX);
    return api('GET',
      `/oauth/authorize?response_type=code&client_id=${clientId}`
      + `&redirect_uri=${encodeURIComponent(redirectUri)}`
      + '&code_challenge=ch&code_challenge_method=S256&scope=market:read',
      { token },
    );
  };

  it('accepts any port on a registered loopback redirect', async () => {
    const c = await mkClient(['http://localhost/callback']);
    const r = await authorize(c.clientId, 'http://localhost:53521/callback');
    expect(r.status).toBe(302);
    expect(r.headers.get('location') ?? '').toContain('/authorize?req=');
  });

  it('still requires the path to match', async () => {
    const c = await mkClient(['http://localhost/callback']);
    const r = await authorize(c.clientId, 'http://localhost:53521/other');
    expect(r.status).toBe(400);
  });

  it('does not extend port-insensitivity to non-loopback hosts', async () => {
    const c = await mkClient(['https://example.com/cb']);
    const r = await authorize(c.clientId, 'https://example.com:8443/cb');
    expect(r.status).toBe(400);
  });

  it('keeps localhost and 127.0.0.1 distinct', async () => {
    const c = await mkClient(['http://localhost/callback']);
    const r = await authorize(c.clientId, 'http://127.0.0.1:9000/callback');
    expect(r.status).toBe(400);
  });

  it('echoes the rejected URI so the real callback can be recovered', async () => {
    const c = await mkClient(['https://example.com/cb']);
    const r = await authorize(c.clientId, 'https://example.com/wrong');
    expect(r.status).toBe(400);
    expect((r.body as Record<string, unknown>).presented).toBe('https://example.com/wrong');
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

  it('consent returns JSON redirectUri when Accept: application/json', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'consent-json', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const { token } = await loginAs(ALEX);
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=ch&code_challenge_method=S256&scope=market:read&state=s1`,
      { token, redirect: 'manual' },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const r = await api('POST', '/oauth/authorize/consent', {
      body: { req }, token,
      headers: { Accept: 'application/json' },
    });
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(typeof body.redirectUri).toBe('string');
    expect(body.redirectUri.startsWith('https://example.com/cb')).toBe(true);
    expect(body.redirectUri).toContain('code=');
  });
});

describe('/oauth/token', () => {
  beforeAll(async () => {
    // Seed a signing key for the test env (helpers/app.ts reads
    // OAUTH_SIGNING_KEY_CURRENT off __TEST_OAUTH_KEY__).
    const { generateSigningKey } = await import('../src/oauth/tokens');
    if (!process.env.__TEST_OAUTH_KEY__) {
      process.env.__TEST_OAUTH_KEY__ = await generateSigningKey();
    }
  });

  it('authorization_code happy path returns access + refresh', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-ac', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const verifier = generateVerifier();
    const challenge = challengeS256(verifier);
    const { token } = await loginAs(ALEX);
    // Park + consent in two steps (matches the post-Task-8 flow).
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=${challenge}&code_challenge_method=S256&scope=market:read&state=st`,
      { token, redirect: 'manual' },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const consent = await api('POST', '/oauth/authorize/consent', {
      body: { req }, token, redirect: 'manual',
    });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const r = await api('POST', '/oauth/token', {
      form: {
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: 'https://example.com/cb',
        client_id: c.clientId, client_secret: c.clientSecret!,
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.access_token).toBe('string');
    expect(typeof body.refresh_token).toBe('string');
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe('market:read');
  });

  // Drives a write-capable client through authorize → consent → token, returning
  // the granted scope string. Mirrors the interactive MCP flow (Claude.ai).
  async function interactiveGrant(consenter: string) {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-write', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'],
      scopes: ['market:read', 'market:write'],
      createdBy: u, public: false,
    });
    const verifier = generateVerifier();
    const challenge = challengeS256(verifier);
    const { token } = await loginAs(consenter);
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=${challenge}&code_challenge_method=S256&scope=market:read%20market:write&state=st`,
      { token, redirect: 'manual' },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const consent = await api('POST', '/oauth/authorize/consent', { body: { req }, token, redirect: 'manual' });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const r = await api('POST', '/oauth/token', {
      form: {
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: 'https://example.com/cb',
        client_id: c.clientId, client_secret: c.clientSecret!, // pragma: allowlist secret
      },
    });
    expect(r.status).toBe(200);
    return (r.body as Record<string, unknown>).scope as string;
  }

  it('interactive flow grants market:write when the consenter is a manager', async () => {
    const scope = await interactiveGrant(ALEX);
    expect(scope.split(' ')).toEqual(expect.arrayContaining(['market:read', 'market:write']));
  });

  it('interactive flow drops market:write for a non-manager consenter', async () => {
    const scope = await interactiveGrant(MARCUS);
    expect(scope).toBe('market:read');
  });

  it('token exchange stays port-exact even for a loopback client', async () => {
    // The authorize-time allowlist ignores loopback ports, but the code records
    // the concrete URI — redeeming it against a different port must fail, or a
    // code minted for one local listener could be replayed against another.
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-loopback', redirectUris: ['http://localhost/callback'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const verifier = generateVerifier();
    const { token } = await loginAs(ALEX);
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}`
      + `&redirect_uri=${encodeURIComponent('http://localhost:5000/callback')}`
      + `&code_challenge=${challengeS256(verifier)}&code_challenge_method=S256&scope=market:read`,
      { token },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const consent = await api('POST', '/oauth/authorize/consent', {
      body: { req }, token, headers: { Accept: 'application/json' },
    });
    const code = new URL((consent.body as any).redirectUri).searchParams.get('code')!;

    const r = await api('POST', '/oauth/token', {
      form: {
        grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: 'http://localhost:5001/callback',  // different port
        client_id: c.clientId, client_secret: c.clientSecret!, // pragma: allowlist secret
      },
    });
    expect(r.status).toBe(400);
    expect((r.body as Record<string, unknown>).error).toBe('invalid_grant');
  });

  it('client_credentials grant issues every scope a multi-scope service client holds', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient, findOAuthClient } = await import('../src/oauth/clients');
    const scopes = ['market:read', 'market:write', 'sellorder:write'];
    const c = await createOAuthClient(sql, {
      name: 'tk-cc-multi', redirectUris: [],
      grantTypes: ['client_credentials'], scopes,
      createdBy: u, public: false,
    });
    // The minted client persists every scope it was created with — not just the first.
    const stored = await findOAuthClient(sql, c.clientId);
    expect(stored?.scopes).toEqual(expect.arrayContaining(scopes));

    const r = await api('POST', '/oauth/token', {
      form: {
        grant_type: 'client_credentials', scope: scopes.join(' '),
        client_id: c.clientId, client_secret: c.clientSecret!, // pragma: allowlist secret
      },
    });
    expect(r.status).toBe(200);
    expect(((r.body as Record<string, unknown>).scope as string).split(' '))
      .toEqual(expect.arrayContaining(scopes));
  });

  it('client_credentials grant rejects a scope the client does not hold', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-cc-narrow', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const r = await api('POST', '/oauth/token', {
      form: {
        grant_type: 'client_credentials', scope: 'market:read sellorder:write',
        client_id: c.clientId, client_secret: c.clientSecret!, // pragma: allowlist secret
      },
    });
    expect(r.status).toBe(400);
    expect((r.body as Record<string, unknown>).error).toBe('invalid_scope');
  });

  it('authorization_code rejects code reuse', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-reuse', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const verifier = generateVerifier();
    const challenge = challengeS256(verifier);
    const { token } = await loginAs(ALEX);
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=${challenge}&code_challenge_method=S256&scope=market:read&state=st`,
      { token, redirect: 'manual' },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const consent = await api('POST', '/oauth/authorize/consent', { body: { req }, token, redirect: 'manual' });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const first = await api('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, code_verifier: verifier,
              redirect_uri: 'https://example.com/cb', client_id: c.clientId, client_secret: c.clientSecret! },
    });
    expect(first.status).toBe(200);
    const second = await api('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, code_verifier: verifier,
              redirect_uri: 'https://example.com/cb', client_id: c.clientId, client_secret: c.clientSecret! },
    });
    expect(second.status).toBe(400);
    expect((second.body as any).error).toBe('invalid_grant');
  });

  it('authorization_code rejects wrong code_verifier', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-wrongv', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const verifier = generateVerifier();
    const challenge = challengeS256(verifier);
    const { token } = await loginAs(ALEX);
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=${challenge}&code_challenge_method=S256&scope=market:read&state=st`,
      { token, redirect: 'manual' },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const consent = await api('POST', '/oauth/authorize/consent', { body: { req }, token, redirect: 'manual' });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const r = await api('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, code_verifier: generateVerifier(),
              redirect_uri: 'https://example.com/cb', client_id: c.clientId, client_secret: c.clientSecret! },
    });
    expect(r.status).toBe(400);
    expect((r.body as any).error).toBe('invalid_grant');
  });

  it('client_credentials grant returns access token only', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-cc', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:write'],
      createdBy: u, public: false,
    });
    const r = await api('POST', '/oauth/token', {
      form: {
        grant_type: 'client_credentials',
        client_id: c.clientId, client_secret: c.clientSecret!,
        scope: 'market:write',
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.access_token).toBe('string');
    expect(body.refresh_token).toBeUndefined();
    expect(body.scope).toBe('market:write');
  });

  it('rejects client_credentials for a client not granted that grant_type', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'wrong-grant', redirectUris: ['https://x/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const r = await api('POST', '/oauth/token', {
      form: { grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret! },
    });
    expect(r.status).toBe(400);
  });

  it('refresh_token grant rotates and invalidates the old token', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-refresh', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const verifier = generateVerifier();
    const challenge = challengeS256(verifier);
    const { token } = await loginAs(ALEX);
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=${challenge}&code_challenge_method=S256&scope=market:read&state=st`,
      { token, redirect: 'manual' },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const consent = await api('POST', '/oauth/authorize/consent', { body: { req }, token, redirect: 'manual' });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const first = await api('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, code_verifier: verifier,
              redirect_uri: 'https://example.com/cb', client_id: c.clientId, client_secret: c.clientSecret! },
    });
    const rt = (first.body as any).refresh_token as string;
    expect(typeof rt).toBe('string');
    const rotate1 = await api('POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: rt,
              client_id: c.clientId, client_secret: c.clientSecret! },
    });
    expect(rotate1.status).toBe(200);
    expect(typeof (rotate1.body as any).access_token).toBe('string');
    // Replay the old refresh token: must fail.
    const rotate2 = await api('POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: rt,
              client_id: c.clientId, client_secret: c.clientSecret! },
    });
    expect(rotate2.status).toBe(400);
  });
});

describe('/oauth/revoke', () => {
  it('client cannot revoke another client\'s token', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const ca = await createOAuthClient(sql, {
      name: 'rev-A', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const cb = await createOAuthClient(sql, {
      name: 'rev-B', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const verifier = generateVerifier();
    const challenge = challengeS256(verifier);
    const { token } = await loginAs(ALEX);
    // Mint a refresh token for client A.
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${ca.clientId}&redirect_uri=https://example.com/cb&code_challenge=${challenge}&code_challenge_method=S256&scope=market:read&state=st`,
      { token, redirect: 'manual' },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const consent = await api('POST', '/oauth/authorize/consent', { body: { req }, token, redirect: 'manual' });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const tk = await api('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, code_verifier: verifier,
              redirect_uri: 'https://example.com/cb', client_id: ca.clientId, client_secret: ca.clientSecret! },
    });
    const rt = (tk.body as any).refresh_token as string;
    // Client B attempts to revoke client A's token.
    const rev = await api('POST', '/oauth/revoke', {
      form: { token: rt, client_id: cb.clientId, client_secret: cb.clientSecret! },
    });
    expect(rev.status).toBe(200); // RFC 7009: silent on unknown/unauthorized — but family must remain alive
    // Client A's token still works for rotation.
    const rot = await api('POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: rt,
              client_id: ca.clientId, client_secret: ca.clientSecret! },
    });
    expect(rot.status).toBe(200);
  });

  it('revokes a refresh token family; subsequent rotate fails', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'tk-revoke', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const verifier = generateVerifier();
    const challenge = challengeS256(verifier);
    const { token } = await loginAs(ALEX);
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=${challenge}&code_challenge_method=S256&scope=market:read&state=st`,
      { token, redirect: 'manual' },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const consent = await api('POST', '/oauth/authorize/consent', { body: { req }, token, redirect: 'manual' });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const tk = await api('POST', '/oauth/token', {
      form: { grant_type: 'authorization_code', code, code_verifier: verifier,
              redirect_uri: 'https://example.com/cb', client_id: c.clientId, client_secret: c.clientSecret! },
    });
    const rt = (tk.body as any).refresh_token as string;
    // Revoke.
    const rev = await api('POST', '/oauth/revoke', {
      form: { token: rt, client_id: c.clientId, client_secret: c.clientSecret! },
    });
    expect(rev.status).toBe(200);
    // Subsequent rotate must fail.
    const rot = await api('POST', '/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: rt,
              client_id: c.clientId, client_secret: c.clientSecret! },
    });
    expect(rot.status).toBe(400);
  });
});

describe('/api/oauth/clients (admin)', () => {
  it('403 for non-managers', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await api('GET', '/api/oauth/clients', { token });
    expect(r.status).toBe(403);
  });

  it('200 list, 201 POST, 200 DELETE for manager', async () => {
    const { token } = await loginAs(ALEX);
    const list1 = await api('GET', '/api/oauth/clients', { token });
    expect(list1.status).toBe(200);
    const beforeCount = ((list1.body as any).clients as any[]).length;

    const post = await api('POST', '/api/oauth/clients', {
      token,
      body: {
        name: 'admin-created-scraper',
        grantTypes: ['client_credentials'],
        scopes: ['market:write'],
        public: false,
      },
    });
    expect(post.status).toBe(201);
    const created = post.body as any;
    expect(typeof created.clientId).toBe('string');
    expect(typeof created.clientSecret).toBe('string');

    const list2 = await api('GET', '/api/oauth/clients', { token });
    expect(((list2.body as any).clients as any[]).length).toBe(beforeCount + 1);
    // Secret must never appear in the list response.
    const listed = ((list2.body as any).clients as any[]).find((c) => c.id === created.clientId);
    expect(listed).toBeTruthy();
    expect((listed as any).clientSecret).toBeUndefined();
    expect((listed as any).secret_hash).toBeUndefined();

    const del = await api('DELETE', `/api/oauth/clients/${created.clientId}`, { token });
    expect(del.status).toBe(200);
    const list3 = await api('GET', '/api/oauth/clients', { token });
    expect(((list3.body as any).clients as any[]).length).toBe(beforeCount);
  });

  it('400s on unknown grant_type', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/oauth/clients', {
      token,
      body: { name: 'bad-grant', grantTypes: ['password'], scopes: ['market:read'] },
    });
    expect(r.status).toBe(400);
  });

  it('400s on unknown scope', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/oauth/clients', {
      token,
      body: { name: 'bad-scope', scopes: ['market.read'] },
    });
    expect(r.status).toBe(400);
  });

  it('mints a connector client with redirect URIs', async () => {
    const { token } = await loginAs(ALEX);
    const redirectUris = ['https://claude.ai/api/mcp/auth_callback'];
    const r = await api('POST', '/api/oauth/clients', {
      token,
      body: {
        name: 'claude-connector',
        grantTypes: ['authorization_code', 'refresh_token'],
        scopes: ['market:read', 'sellorder:read'],
        redirectUris,
      },
    });
    expect(r.status).toBe(201);
    const body = r.body as any;
    expect(typeof body.clientId).toBe('string');
    expect(typeof body.clientSecret).toBe('string');
    expect(body.redirectUris).toEqual(redirectUris);
  });

  it('400s when an authorization_code client has no redirect URIs', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/oauth/clients', {
      token,
      body: { name: 'no-callback', grantTypes: ['authorization_code'], scopes: ['market:read'] },
    });
    expect(r.status).toBe(400);
  });

  it('400s on a redirect URI outside the allowlist', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('POST', '/api/oauth/clients', {
      token,
      body: {
        name: 'xss', grantTypes: ['authorization_code'], scopes: ['market:read'],
        redirectUris: ['javascript:alert(1)'],
      },
    });
    expect(r.status).toBe(400);
  });

  it('list response includes lastUsedAt (null when no live refresh tokens)', async () => {
    const { token } = await loginAs(ALEX);
    const list = await api('GET', '/api/oauth/clients', { token });
    expect(list.status).toBe(200);
    const clients = (list.body as any).clients as any[];
    expect(clients.length).toBeGreaterThan(0);
    // Newly-created clients with no refresh tokens have lastUsedAt = null.
    expect(clients.every(c => 'lastUsedAt' in c)).toBe(true);
  });
});

describe('/oauth/authorize/deny', () => {
  it('redirects to client with error=access_denied', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'deny-test', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const { token } = await loginAs(ALEX);
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=ch&code_challenge_method=S256&scope=market:read&state=s1`,
      { token, redirect: 'manual' },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const r = await api('POST', '/oauth/authorize/deny', {
      body: { req }, token, redirect: 'manual',
    });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('s1');
  });

  it('returns JSON with redirectUri when Accept: application/json', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const { createOAuthClient } = await import('../src/oauth/clients');
    const c = await createOAuthClient(sql, {
      name: 'deny-json', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const { token } = await loginAs(ALEX);
    const start = await api('GET',
      `/oauth/authorize?response_type=code&client_id=${c.clientId}&redirect_uri=https://example.com/cb&code_challenge=ch&code_challenge_method=S256&scope=market:read&state=s2`,
      { token, redirect: 'manual' },
    );
    const req = new URL(start.headers.get('location')!, 'http://localhost').searchParams.get('req')!;
    const r = await api('POST', '/oauth/authorize/deny', {
      body: { req }, token,
      headers: { Accept: 'application/json' },
    });
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.redirectUri).toContain('error=access_denied');
    expect(body.redirectUri).toContain('state=s2');
  });
});
