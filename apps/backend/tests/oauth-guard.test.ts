import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient } from '../src/oauth/clients';
import { signAccessToken, generateSigningKey } from '../src/oauth/tokens';
import { bearerGuard } from '../src/oauth/guard';

describe('bearerGuard', () => {
  let env: any;
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    env = {
      OAUTH_ISSUER_URL: 'https://erp.test', OAUTH_SIGNING_KEY_CURRENT: key,
      OAUTH_ACCESS_TOKEN_TTL_SEC: '60',
    };
  });

  function buildApp(scopes: ('market:read'|'market:write')[]) {
    const app = new Hono<{ Bindings: any }>();
    app.use('*', bearerGuard({ scopes }));
    app.get('/ok', (c) => c.json({ ok: true }));
    return app;
  }

  it('401 without bearer + WWW-Authenticate header', async () => {
    const r = await buildApp(['market:read']).request('/ok', {}, env);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
  });

  it('401 with tampered signature', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'gd', redirectUris: ['https://x/cb'],
      grantTypes: ['authorization_code'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const at = await signAccessToken(env, { clientId: c.clientId, userId: null, scopes: ['market:read'] });
    const tampered = at.slice(0, -4) + 'AAAA';
    const r = await buildApp(['market:read']).request('/ok', {
      headers: { authorization: `Bearer ${tampered}` },
    }, env);
    expect(r.status).toBe(401);
  });

  it('403 when token scope does not include required scope', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'gd2', redirectUris: ['https://x/cb'],
      grantTypes: ['client_credentials'], scopes: ['market:read','market:write'],
      createdBy: u, public: false,
    });
    const at = await signAccessToken(env, { clientId: c.clientId, userId: null, scopes: ['market:read'] });
    const r = await buildApp(['market:write']).request('/ok', {
      headers: { authorization: `Bearer ${at}` },
    }, env);
    expect(r.status).toBe(403);
  });

  it('200 with valid scope and sets c.var.oauthCtx', async () => {
    const sql = getTestDb();
    const u = (await sql<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const c = await createOAuthClient(sql, {
      name: 'gd3', redirectUris: ['https://x/cb'],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
    const at = await signAccessToken(env, { clientId: c.clientId, userId: null, scopes: ['market:read'] });
    const r = await buildApp(['market:read']).request('/ok', {
      headers: { authorization: `Bearer ${at}` },
    }, env);
    expect(r.status).toBe(200);
  });
});
