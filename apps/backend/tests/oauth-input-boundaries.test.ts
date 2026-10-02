import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import app from '../src/index';
import { createOAuthClient } from '../src/oauth/clients';
import { generateSigningKey } from '../src/oauth/tokens';

type Body = Record<string, unknown>;

beforeAll(async () => {
  if (!process.env.__TEST_OAUTH_KEY__) process.env.__TEST_OAUTH_KEY__ = await generateSigningKey();
});

async function confidentialClient(grantTypes: string[]) {
  return createOAuthClient(getTestDb(), {
    name: 'boundary', redirectUris: ['https://example.com/cb'],
    grantTypes, scopes: ['market:read'], createdBy: null, public: false,
  });
}

// The JSON branch of the token endpoint, sent raw so a test can hand it
// malformed text or a non-object.
async function tokenJson(raw: string): Promise<{ status: number; body: Body }> {
  const res = await app.fetch(new Request('http://test/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  }), testEnv);
  return { status: res.status, body: await res.json() as Body };
}

describe('/oauth/token reads only string fields from a JSON body', () => {
  beforeEach(async () => { await resetDb(); });

  it('answers invalid_client, not a 500, for unparseable JSON', async () => {
    const r = await tokenJson('{not json');
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_client');
  });

  it('answers invalid_client for a JSON array', async () => {
    const r = await tokenJson('[1,2]');
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_client');
  });

  it('treats a non-string code as missing', async () => {
    const c = await confidentialClient(['authorization_code', 'refresh_token']);
    const r = await api<Body>('POST', '/oauth/token', {
      body: {
        grant_type: 'authorization_code', code: { $ne: null }, code_verifier: 'v',
        redirect_uri: 'https://example.com/cb', client_id: c.clientId, client_secret: c.clientSecret,
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_request');
  });

  it('treats a non-string refresh_token as missing', async () => {
    const c = await confidentialClient(['authorization_code', 'refresh_token']);
    const r = await api<Body>('POST', '/oauth/token', {
      body: {
        grant_type: 'refresh_token', refresh_token: ['a'],
        client_id: c.clientId, client_secret: c.clientSecret,
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_request');
  });

  it('treats a non-string client_id as no credentials', async () => {
    const r = await api<Body>('POST', '/oauth/token', {
      body: { grant_type: 'client_credentials', client_id: 7, client_secret: 's' },
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('invalid_client');
  });

  it('treats a non-string scope as no scope', async () => {
    const c = await confidentialClient(['client_credentials']);
    const r = await api<Body>('POST', '/oauth/token', {
      body: {
        grant_type: 'client_credentials', scope: ['market:read'],
        client_id: c.clientId, client_secret: c.clientSecret,
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_scope');
  });

  it('revoke ignores a non-string token', async () => {
    const c = await confidentialClient(['authorization_code', 'refresh_token']);
    const r = await api<Body>('POST', '/oauth/revoke', {
      body: { token: { a: 1 }, client_id: c.clientId, client_secret: c.clientSecret },
    });
    expect(r.status).toBe(200);
  });
});

describe('DCR /oauth/register validates its metadata', () => {
  beforeEach(async () => { await resetDb(); });

  const register = (body: unknown) => api<Body>('POST', '/oauth/register', { body });
  const base = { client_name: 'connector', redirect_uris: ['https://example.com/cb'] };

  it('rejects a non-string client_name', async () => {
    const r = await register({ ...base, client_name: { a: 1 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_client_metadata');
  });

  it('rejects a client_name over 80 characters', async () => {
    const r = await register({ ...base, client_name: 'n'.repeat(81) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_client_metadata');
    expect((await register({ ...base, client_name: 'n'.repeat(80) })).status).toBe(201);
  });

  it('strips control characters from client_name before storing it', async () => {
    const r = await register({ ...base, client_name: 'Evil\u0000\u001b[31m Co\n' });
    expect(r.status).toBe(201);
    expect(r.body.client_name).toBe('Evil[31m Co');
    const [row] = await getTestDb()<{ name: string }[]>`
      SELECT name FROM oauth_clients WHERE id = ${r.body.client_id as string}
    `;
    expect(row.name).toBe('Evil[31m Co');
  });

  it('rejects a client_name that is only control characters', async () => {
    expect((await register({ ...base, client_name: '\u0007\u0008' })).status).toBe(400);
  });

  it('rejects grant_types that is not an array of strings', async () => {
    expect((await register({ ...base, grant_types: 'authorization_code' })).status).toBe(400);
    expect((await register({ ...base, grant_types: [1] })).status).toBe(400);
  });

  it('rejects redirect_uris carrying a non-string', async () => {
    const r = await register({ ...base, redirect_uris: ['https://example.com/cb', 5] });
    expect(r.status).toBe(400);
  });

  it('rejects a non-string scope', async () => {
    const r = await register({ ...base, scope: ['market:read'] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_client_metadata');
  });
});

describe('DCR unused-client cap', () => {
  beforeEach(async () => { await resetDb(); });

  async function seedUnused(n: number, age: string) {
    const tag = crypto.randomUUID().slice(0, 8);
    await getTestDb().unsafe(`
      INSERT INTO oauth_clients (id, name, redirect_uris, grant_types, scopes, created_by, created_ip, created_at)
      SELECT 'unused-${tag}-' || g, 'abandoned', ARRAY['https://x/cb'], ARRAY['authorization_code'],
             ARRAY['market:read'], NULL, '198.51.100.9', NOW() - INTERVAL '${age}'
      FROM generate_series(1, ${n}) g
    `); // nosec — test-only literals
  }

  const register = () => api<Body>('POST', '/oauth/register', {
    body: { client_name: 'fresh', redirect_uris: ['https://example.com/cb'] },
  });

  it('ignores abandoned registrations older than a day', async () => {
    await seedUnused(200, '2 days');
    expect((await register()).status).toBe(201);
  });

  it('still trips on abandoned registrations within the day', async () => {
    await seedUnused(200, '2 hours');
    const r = await register();
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('temporarily_unavailable');
  });
});
