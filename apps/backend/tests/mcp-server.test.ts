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
    expect(names).toEqual(['get_market_value','list_market_values','set_market_price']);
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

describe('MCP set_market_price tool', () => {
  let bearerWrite: string;
  let bearerRead: string;
  let knownPartNumber: string;
  let knownId: string;
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    process.env.__TEST_OAUTH_KEY__ = key;
    process.env.OAUTH_ISSUER_URL = 'http://localhost:8787';
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const env = {
      OAUTH_ISSUER_URL: 'http://localhost:8787',
      OAUTH_SIGNING_KEY_CURRENT: key,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '900',
    } as any;
    // The /api/mcp mount requires market:read, so a write-capable client holds both.
    const wc = await createOAuthClient(sql, {
      name: 'mcp-writer', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read', 'market:write'],
      createdBy: u, public: false,
    });
    const rc = await createOAuthClient(sql, {
      name: 'mcp-reader', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    bearerWrite = await signAccessToken(env, {
      clientId: wc.clientId, userId: null, scopes: ['market:read', 'market:write'],
    });
    bearerRead = await signAccessToken(env, {
      clientId: rc.clientId, userId: null, scopes: ['market:read'],
    });
    const row = (await sql<{ id: string; part_number: string }[]>`
      SELECT id, part_number FROM ref_prices
      WHERE part_number IS NOT NULL AND part_number <> '' LIMIT 1
    `)[0];
    knownId = row.id;
    knownPartNumber = row.part_number;
  });

  function callWrite(bearer: string, args: unknown, id = 9) {
    return api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearer}` },
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'set_market_price', arguments: args } },
    });
  }

  it('refuses a market:read-only token with insufficient_scope', async () => {
    const r = await callWrite(bearerRead, { partNumber: knownPartNumber, price: 123.45 });
    const body = r.body as any;
    expect(body.result).toBeUndefined();
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/insufficient_scope/);
  });

  it('updates last_price by part number and appends an event', async () => {
    const sql = getTestDb();
    const before = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${knownId}
    `)[0].c;
    const r = await callWrite(bearerWrite, { partNumber: knownPartNumber, price: 222.5 });
    const body = r.body as any;
    expect(body.error).toBeUndefined();
    const payload = JSON.parse(body.result.content[0].text);
    expect(payload.lastPrice).toBe(222.5);

    const after = (await sql<{ last_price: number; last_price_source: string }[]>`
      SELECT last_price::float AS last_price, last_price_source FROM ref_prices WHERE id = ${knownId}
    `)[0];
    expect(after.last_price).toBe(222.5);
    expect(after.last_price_source).toMatch(/^mcp:/);

    const ev = (await sql<{ c: number; latest_source: string }[]>`
      SELECT COUNT(*)::int AS c,
             (SELECT source FROM ref_price_events WHERE ref_price_id = ${knownId}
              ORDER BY created_at DESC LIMIT 1) AS latest_source
      FROM ref_price_events WHERE ref_price_id = ${knownId}
    `)[0];
    expect(ev.c).toBe(before + 1);
    expect(ev.latest_source).toMatch(/^mcp:/);
  });

  it('returns not_found for an unknown part number', async () => {
    const r = await callWrite(bearerWrite, { partNumber: 'NEVER-EXISTS-XYZ', price: 10 });
    const body = r.body as any;
    expect(body.error).toBeDefined();
    expect(body.error.message).toMatch(/not_found/);
  });

  it('rejects a negative price', async () => {
    const r = await callWrite(bearerWrite, { partNumber: knownPartNumber, price: -1 });
    expect((r.body as any).error).toBeDefined();
  });
});
