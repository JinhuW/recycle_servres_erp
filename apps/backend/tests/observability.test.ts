import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey } from '../src/oauth/tokens';
import { api } from './helpers/app';

describe('observability counters', () => {
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    process.env.__TEST_OAUTH_KEY__ = key;
    process.env.OAUTH_ISSUER_URL = 'http://localhost:8787';
  });

  it('increments oauth_grants_total, mcp_tool_calls_total, market_writes_total', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'metrics-test',
      redirectUris: [],
      grantTypes: ['client_credentials'],
      scopes: ['market:read', 'market:write'],
      createdBy: u,
      public: false,
    });

    // 1. Mint a client_credentials access token.
    const tk = await api('POST', '/oauth/token', {
      form: {
        grant_type: 'client_credentials',
        client_id: c.clientId,
        client_secret: c.clientSecret!,
        scope: 'market:read market:write',
      },
    });
    expect(tk.status).toBe(200);
    const bearer = (tk.body as { access_token: string }).access_token;

    // 2. Call an MCP tool.
    const mcp = await api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearer}` },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_market_values', arguments: { limit: 2 } },
      },
    });
    expect(mcp.status).toBe(200);

    // 3. Write to market — one known row + one bogus partNumber.
    const knownId = (await sql<{ id: string }[]>`SELECT id FROM ref_prices LIMIT 1`)[0].id;
    const mw = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${bearer}` },
      body: {
        values: [
          { selector: { id: knownId }, low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'metrics-test' },
          { selector: { partNumber: 'NEVER-EXISTS-METRICS' }, low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'x' },
        ],
      },
    });
    expect(mw.status).toBe(200);

    // 4. Scrape /metrics — body comes back as plain text since JSON.parse fails.
    const m = await api('GET', '/metrics');
    expect(m.status).toBe(200);
    const text = m.body as unknown as string;

    expect(text).toMatch(/oauth_grants_total\{[^}]*grant_type="client_credentials"[^}]*status="ok"\}\s+\d+/);
    expect(text).toMatch(/mcp_tool_calls_total\{[^}]*tool="list_market_values"[^}]*status="ok"\}\s+\d+/);
    expect(text).toMatch(/market_writes_total\{[^}]*outcome="updated"\}\s+\d+/);
    expect(text).toMatch(/market_writes_total\{[^}]*outcome="notfound"\}\s+\d+/);
  });

  it('increments oauth_refresh_revocations_total on client revoke + reuse', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'revoke-metrics',
      redirectUris: [],
      grantTypes: ['client_credentials'],
      scopes: ['market:read'],
      createdBy: u,
      public: false,
    });

    // Seed a live refresh-token family for this client so revokeOAuthClient
    // has something to cascade-revoke (client_credentials clients don't
    // normally hold refresh tokens, but the SQL doesn't enforce that and
    // we just want the cascade path exercised).
    const familyId = crypto.randomUUID();
    await sql`
      INSERT INTO oauth_refresh_tokens
        (token_hash, client_id, user_id, scopes, family_id, expires_at)
      VALUES
        ('deadbeef-revoke-metrics', ${c.clientId}, ${u}, ${['market:read']},
         ${familyId}, NOW() + INTERVAL '1 day')
    `;

    const { revokeOAuthClient } = await import('../src/oauth/clients');
    await revokeOAuthClient(sql, c.clientId);

    const m = await api('GET', '/metrics');
    expect(m.status).toBe(200);
    const text = m.body as unknown as string;
    expect(text).toMatch(/oauth_refresh_revocations_total\{reason="client_revoked"\}\s+\d+/);
  });
});
