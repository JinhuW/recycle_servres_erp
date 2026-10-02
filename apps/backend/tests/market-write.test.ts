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

  it('updates an existing row, appends an event, recomputes trend', async () => {
    const sql = getTestDb();
    const beforeEvents = (await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM ref_price_events WHERE ref_price_id = ${knownId}
    `)[0].c;
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

    const after = (await sql<{ avg_sell: number; samples: number; trend: number | null; source: string; last_price: number; last_price_source: string }[]>`
      SELECT avg_sell::float AS avg_sell, samples, trend, source,
             last_price::float AS last_price, last_price_source
      FROM ref_prices WHERE id = ${knownId}
    `)[0];
    expect(after.avg_sell).toBe(130);
    expect(after.samples).toBe(9);
    expect(after.source).toBe('test-scraper');
    expect(after.last_price).toBe(130);
    expect(after.last_price_source).toBe('scraper:test-scraper');

    const afterEvents = (await sql<{ c: number; latest_source: string; latest_actor: string | null }[]>`
      SELECT COUNT(*)::int AS c,
             (SELECT source FROM ref_price_events
              WHERE ref_price_id = ${knownId} ORDER BY created_at DESC LIMIT 1) AS latest_source,
             (SELECT actor_user_id FROM ref_price_events
              WHERE ref_price_id = ${knownId} ORDER BY created_at DESC LIMIT 1) AS latest_actor
      FROM ref_price_events WHERE ref_price_id = ${knownId}
    `)[0];
    expect(afterEvents.c).toBe(beforeEvents + 1);
    expect(afterEvents.latest_source).toBe('scraper:test-scraper');
    expect(afterEvents.latest_actor).toBeNull();
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

  it('turns a malformed element into an error row instead of failing the batch', async () => {
    const good = { selector: { id: knownId }, low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'ok' };
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: {
        values: [
          null,
          'row',
          { low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'x' },
          { selector: { id: knownId, partNumber: 'X' }, low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'x' },
          { selector: {}, low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'x' },
          { selector: { id: 42 }, low: '1', high: '2', avgSell: '1.5', samples: 1, source: 'x' },
          { selector: { id: knownId }, low: '1', high: '2', avgSell: '1.5', samples: 1 },
          { selector: { id: knownId }, low: null, high: '2', avgSell: '1.5', samples: 1, source: 'x' },
          good,
        ],
      },
    });
    expect(r.status).toBe(200);
    const body = r.body as { updated: number; notFound: number; errors: { selector: unknown; error: string }[] };
    expect(body.updated).toBe(1);
    expect(body.notFound).toBe(0);
    expect(body.errors).toHaveLength(8);
    expect(body.errors[3].error).toMatch(/exactly one/);
    // A non-string selector field is not echoed back.
    expect(body.errors[5].selector).toEqual({});
    expect(body.errors[7].error).toMatch(/non-numeric/);
  });

  it('writes the most recently updated row when a part number matches two', async () => {
    const sql = getTestDb();
    const [src] = await sql<{ id: string; part_number: string }[]>`
      SELECT id, part_number FROM ref_prices WHERE part_number IS NOT NULL AND part_number <> '' LIMIT 1`;
    const [twin] = await sql<{ id: string }[]>`
      INSERT INTO ref_prices (id, category, label, part_number, target, low_price, high_price, avg_sell, updated_at)
      SELECT 'twin-' || id, category, label, part_number, target, low_price, high_price, avg_sell,
             NOW() + INTERVAL '1 day'
      FROM ref_prices WHERE id = ${src.id}
      RETURNING id`;
    const r = await api('POST', '/api/market/values', {
      headers: { authorization: `Bearer ${writeBearer}` },
      body: {
        values: [{
          selector: { partNumber: src.part_number },
          low: '10', high: '30', avgSell: '20', samples: 2, source: 'twin-check',
        }],
      },
    });
    expect((r.body as { updated: number }).updated).toBe(1);
    const rows = await sql<{ id: string; source: string | null }[]>`
      SELECT id, source FROM ref_prices WHERE id IN (${src.id}, ${twin.id})`;
    expect(rows.find((x) => x.id === twin.id)?.source).toBe('twin-check');
    expect(rows.find((x) => x.id === src.id)?.source).not.toBe('twin-check');
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
