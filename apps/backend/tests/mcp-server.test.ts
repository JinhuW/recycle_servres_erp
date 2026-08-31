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
    expect(body.result.serverInfo.name).toBe('recycle-erp-mcp');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('tools/list filters by granted scope (read-only token: read tools only)', async () => {
    const r = await api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearerRead}` },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    const names = (r.body as any).result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['get_market_value', 'list_market_values']);
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

  // A tool that ran and failed must come back as an isError *result*, never a
  // JSON-RPC error: ChatGPT relays a protocol error to the model as
  // `{"type":"json_rpc_error",…}`, which it read as "the write endpoint is
  // down" and stopped writing after a single mistyped part number.
  it('returns not_found as a tool result, not a protocol error', async () => {
    const r = await callWrite(bearerWrite, { partNumber: 'NEVER-EXISTS-XYZ', price: 10 });
    const body = r.body as any;
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    const text = body.result.content[0].text;
    expect(text).toMatch(/not_found/);
    // Naming the part back is what makes the failure correctable.
    expect(text).toMatch(/NEVER-EXISTS-XYZ/);
  });

  it('rejects a negative price as a tool result', async () => {
    const r = await callWrite(bearerWrite, { partNumber: knownPartNumber, price: -1 });
    const body = r.body as any;
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/invalid_price/);
  });

  it('keeps insufficient_scope a protocol error', async () => {
    const r = await callWrite(bearerRead, { partNumber: knownPartNumber, price: 1 });
    const body = r.body as any;
    expect(body.result).toBeUndefined();
    expect(body.error.message).toMatch(/insufficient_scope/);
  });

  it('keeps an unknown tool a protocol error', async () => {
    const r = await api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearerWrite}` },
      body: { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
    });
    const body = r.body as any;
    expect(body.result).toBeUndefined();
    expect(body.error.code).toBe(-32601);
  });

  // Absent annotations mean the MCP defaults — destructive, open-world, not
  // read-only — which is how ChatGPT came to label every tool here a
  // destructive public write and gate the read tools behind elevated risk.
  it('advertises annotations that separate the read tools from the write one', async () => {
    const r = await api('POST', '/api/mcp', {
      headers: { authorization: `Bearer ${bearerWrite}` },
      body: { jsonrpc: '2.0', id: 12, method: 'tools/list', params: {} },
    });
    const tools = (r.body as any).result.tools as Array<{ name: string; annotations?: Record<string, boolean> }>;
    for (const t of tools) expect(t.annotations, `${t.name} has no annotations`).toBeDefined();
    const byName = new Map(tools.map(t => [t.name, t.annotations!]));
    expect(byName.get('list_market_values')!.readOnlyHint).toBe(true);
    expect(byName.get('get_market_value')!.readOnlyHint).toBe(true);
    expect(byName.get('set_market_price')!.readOnlyHint).toBe(false);
    expect(byName.get('set_market_price')!.destructiveHint).toBe(false);
    for (const t of tools) expect(t.annotations!.openWorldHint).toBe(false);
  });
});

describe('MCP JSON-RPC transport conformance', () => {
  let bearer: string;
  beforeAll(async () => {
    const key = process.env.__TEST_OAUTH_KEY__ ?? await generateSigningKey();
    process.env.__TEST_OAUTH_KEY__ = key;
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'mcp-conformance', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    bearer = await signAccessToken({
      OAUTH_ISSUER_URL: 'http://localhost:8787',
      OAUTH_SIGNING_KEY_CURRENT: key,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '900',
    } as any, { clientId: c.clientId, userId: null, scopes: ['market:read'] });
  });

  const post = (body: unknown) => api('POST', '/api/mcp', {
    headers: { authorization: `Bearer ${bearer}` },
    body: body as any,
  });

  it('answers a notification with 202 and no body', async () => {
    // Every client sends notifications/initialized right after initialize.
    // Replying with a JSON-RPC error object carrying an undefined id is not a
    // valid response and trips strict clients.
    const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
    expect(r.body).toBeUndefined();
  });

  it('echoes a protocol version it speaks', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect((r.body as any).result.protocolVersion).toBe('2025-06-18');
  });

  it('answers with its newest version when asked for one it does not speak', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect((r.body as any).result.protocolVersion).toBe('2025-06-18');
  });

  it('responds to ping', async () => {
    const r = await post({ jsonrpc: '2.0', id: 7, method: 'ping' });
    expect((r.body as any).result).toEqual({});
    expect((r.body as any).id).toBe(7);
  });

  it('rejects a JSON-RPC batch with id null, not undefined', async () => {
    // JSON.stringify drops an undefined id, producing a response with no id
    // field at all — which is itself malformed.
    const r = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    const body = r.body as any;
    expect(body.error.code).toBe(-32600);
    expect(body.id).toBeNull();
  });

  it('rejects a body with no method', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1 });
    expect((r.body as any).error.code).toBe(-32600);
  });
});
