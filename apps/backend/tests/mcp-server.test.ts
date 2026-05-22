import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient } from '../src/oauth/clients';
import { signAccessToken, generateSigningKey } from '../src/oauth/tokens';
import { api } from './helpers/app';

describe('MCP server /api/mcp', () => {
  let bearerRead: string;
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    process.env.__TEST_OAUTH_KEY__ = key;
    process.env.OAUTH_ISSUER_URL = 'http://localhost:8787';
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'mcp', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const env = {
      OAUTH_ISSUER_URL: 'http://localhost:8787',
      OAUTH_SIGNING_KEY_CURRENT: key,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '900',
    } as any;
    bearerRead = await signAccessToken(env, {
      clientId: c.clientId, userId: null, scopes: ['market:read'],
    });
  });

  it('401 without bearer', async () => {
    const r = await api('POST', '/api/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
  });

  it('initialize returns expected serverInfo + capabilities', async () => {
    const r = await api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearerRead}` },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } },
    });
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.result.serverInfo.name).toBe('recycle-erp-market');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('tools/list returns list_market_values + get_market_value', async () => {
    const r = await api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearerRead}` },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    const names = (r.body as any).result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['get_market_value','list_market_values']);
  });

  it('tools/call list_market_values returns rows', async () => {
    const r = await api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearerRead}` },
      body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_market_values', arguments: { limit: 3 } } },
    });
    const body = r.body as any;
    expect(body.result.isError).toBeFalsy();
    const text = body.result.content[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    if (parsed.length > 0) {
      expect(typeof parsed[0].label).toBe('string');
      expect(typeof parsed[0].maxBuy).toBe('number');
    }
  });
});
