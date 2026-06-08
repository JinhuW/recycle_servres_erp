import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient } from '../src/oauth/clients';
import { signAccessToken, generateSigningKey } from '../src/oauth/tokens';
import { api } from './helpers/app';
import { loginAs, ALEX } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';

describe('MCP sell-order migration seed', () => {
  beforeAll(async () => { await resetDb(); });

  it('seeds the MCP customer and the default-customer setting', async () => {
    const sql = getTestDb();
    const cust = (await sql<{ name: string }[]>`
      SELECT name FROM customers WHERE id = 'f30f98bc-09c7-4108-b083-c7d69cc9968c'
    `)[0];
    expect(cust?.name).toBe('MCP');
    const setting = (await sql<{ value: string }[]>`
      SELECT value FROM workspace_settings WHERE key = 'mcp.sellOrderCustomerId'
    `)[0];
    expect(setting?.value).toBe('f30f98bc-09c7-4108-b083-c7d69cc9968c');
  });
});

describe('MCP search_sellable_inventory', () => {
  let bearerRead: string;
  let bearerNone: string;
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
    const rc = await createOAuthClient(sql, {
      name: 'so-reader', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['sellorder:read'],
      createdBy: u, public: false,
    });
    const nc = await createOAuthClient(sql, {
      name: 'market-only', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    bearerRead = await signAccessToken(env, { clientId: rc.clientId, userId: null, scopes: ['sellorder:read'] });
    bearerNone = await signAccessToken(env, { clientId: nc.clientId, userId: null, scopes: ['market:read'] });
  });

  const call = (bearer: string, args: unknown, id = 1) =>
    api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearer}` },
      body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search_sellable_inventory', arguments: args } },
    });

  it('lists sellable lines with a derived label and availableQty', async () => {
    const r = await call(bearerRead, { limit: 5 });
    const body = r.body as any;
    expect(body.error).toBeUndefined();
    const rows = JSON.parse(body.result.content[0].text);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].inventoryId).toBe('string');
    expect(typeof rows[0].label).toBe('string');
    expect(typeof rows[0].availableQty).toBe('number');
  });

  it('excludes lines already on an open sell order', async () => {
    const { token } = await loginAs(ALEX);
    const line = await freeSellableLine(token);
    const customerId = (await api<{ items: { id: string }[] }>('GET', '/api/customers', { token })).body.items[0].id;
    const created = await api<{ id: string }>('POST', '/api/sell-orders', {
      token,
      body: { customerId, lines: [{ inventoryId: line.id, category: 'RAM', label: 'x', qty: 1, unitPrice: line.sell_price }] },
    });
    expect(created.status).toBe(201);
    const r = await call(bearerRead, { limit: 200 });
    const rows = JSON.parse((r.body as any).result.content[0].text);
    expect(rows.some((x: any) => x.inventoryId === line.id)).toBe(false);
  });

  it('refuses a token without sellorder:read', async () => {
    const r = await call(bearerNone, { limit: 5 });
    const body = r.body as any;
    expect(body.result).toBeUndefined();
    expect(body.error.message).toMatch(/insufficient_scope/);
  });
});
