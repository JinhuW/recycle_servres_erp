import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient } from '../src/oauth/clients';
import { signAccessToken, generateSigningKey } from '../src/oauth/tokens';
import { api } from './helpers/app';

describe('POST /api/market/values', () => {
  let writeBearer: string;
  let readBearer: string;
  let knownId: string;
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    process.env.__TEST_OAUTH_KEY__ = key;
    process.env.OAUTH_ISSUER_URL = 'http://localhost:8787';
    const env = {
      OAUTH_ISSUER_URL: 'http://localhost:8787',
      OAUTH_SIGNING_KEY_CURRENT: key,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '900',
    } as any;
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const wc = await createOAuthClient(sql, {
      name: 'scraper', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:write'],
      createdBy: u, public: false,
    });
    const rc = await createOAuthClient(sql, {
      name: 'reader-only', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    writeBearer = await signAccessToken(env, {
      clientId: wc.clientId, userId: null, scopes: ['market:write'],
    });
    readBearer = await signAccessToken(env, {
      clientId: rc.clientId, userId: null, scopes: ['market:read'],
    });
    knownId = (await sql<{ id: string }[]>`SELECT id FROM ref_prices LIMIT 1`)[0].id;
  });

  it('401 without bearer', async () => {
    const r = await api('POST', '/api/market/values', { body: { values: [] } });
    expect(r.status).toBe(401);
  });

  it('403 with market:read-only bearer', async () => {
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${readBearer}` },
      body: { values: [] },
    });
    expect(r.status).toBe(403);
  });

  it('updates an existing row, appends history, recomputes trend', async () => {
    const sql = getTestDb();
    const before = (await sql<{ avg_sell: number; samples: number | null; history: unknown }[]>`
      SELECT avg_sell::float AS avg_sell, samples, history FROM ref_prices WHERE id = ${knownId}
    `)[0];
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: {
        values: [{
          selector: { id: knownId },
          low: '100.00', high: '160.00', avgSell: '130.00',
          samples: 9, source: 'test-scraper',
        }],
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as any;
    expect(body.updated).toBe(1);
    expect(body.notFound).toBe(0);
    expect(body.errors).toEqual([]);
    const after = (await sql<{ avg_sell: number; samples: number; trend: number | null; source: string; history: any }[]>`
      SELECT avg_sell::float AS avg_sell, samples, trend, source, history FROM ref_prices WHERE id = ${knownId}
    `)[0];
    expect(after.avg_sell).toBe(130);
    expect(after.samples).toBe(9);
    expect(after.source).toBe('test-scraper');
    expect(Array.isArray(after.history)).toBe(true);
    expect(after.history.length).toBeGreaterThan((Array.isArray(before.history) ? before.history.length : 0));
  });

  it('reports notFound for unknown selectors', async () => {
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: {
        values: [{
          selector: { partNumber: 'NEVER-EXISTS-XYZ' },
          low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'x',
        }],
      },
    });
    expect(r.status).toBe(200);
    expect((r.body as any).updated).toBe(0);
    expect((r.body as any).notFound).toBe(1);
  });

  it('records validation errors but processes other rows', async () => {
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: {
        values: [
          { selector: { id: knownId }, low: '5', high: '4', avgSell: '4.5', samples: 1, source: 'x' },
          { selector: { id: knownId }, low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'y' },
        ],
      },
    });
    const body = r.body as any;
    expect(body.updated).toBe(1);
    expect(body.errors.length).toBe(1);
  });

  it('413 on >500 values', async () => {
    const values = Array.from({ length: 501 }, () => ({
      selector: { id: knownId },
      low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'x',
    }));
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: { values },
    });
    expect(r.status).toBe(413);
  });
});
