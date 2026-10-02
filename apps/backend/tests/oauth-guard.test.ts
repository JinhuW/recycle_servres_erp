import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { resetDb, getTestDb, TEST_DATABASE_URL } from './helpers/db';
import { createOAuthClient, revokeOAuthClient } from '../src/oauth/clients';
import { signAccessToken, generateSigningKey, verifyAccessToken } from '../src/oauth/tokens';
import { bearerGuard } from '../src/oauth/guard';

describe('bearerGuard', () => {
  let env: any;
  beforeAll(async () => {
    await resetDb();
    const key = await generateSigningKey();
    env = {
      DATABASE_URL: TEST_DATABASE_URL,
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

  // Each liveness test gets its own user and client, so one test's revocation
  // can't leak into the next.
  async function userGrant() {
    const sql = getTestDb();
    const tag = crypto.randomUUID().slice(0, 8);
    const [u] = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, initials, role, password_hash, active)
      VALUES (${`guard-${tag}@test.local`}, 'Guard Test', 'GT', 'manager', 'x', TRUE)
      RETURNING id
    `;
    const c = await createOAuthClient(sql, {
      name: `guard-${tag}`, redirectUris: ['https://x/cb'],
      grantTypes: ['authorization_code', 'refresh_token'], scopes: ['market:read'],
      createdBy: null, public: false,
    });
    const at = await signAccessToken(env, { clientId: c.clientId, userId: u.id, scopes: ['market:read'] });
    const iat = (await verifyAccessToken(env, at))!.iat;
    const call = () => buildApp(['market:read']).request('/ok', {
      headers: { authorization: `Bearer ${at}` },
    }, env);
    return { userId: u.id, clientId: c.clientId, iat, call };
  }

  it('200 for a live user grant', async () => {
    const g = await userGrant();
    expect((await g.call()).status).toBe(200);
  });

  it('401 once the client is revoked', async () => {
    const g = await userGrant();
    await revokeOAuthClient(getTestDb(), g.clientId);
    const r = await g.call();
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/invalid_token/);
  });

  it('401 once the user is deactivated', async () => {
    const g = await userGrant();
    await getTestDb()`UPDATE users SET active = FALSE WHERE id = ${g.userId}`;
    expect((await g.call()).status).toBe(401);
  });

  it('401 for a token issued before the password changed', async () => {
    const g = await userGrant();
    await getTestDb()`UPDATE users SET tokens_valid_after = to_timestamp(${g.iat + 1}) WHERE id = ${g.userId}`;
    expect((await g.call()).status).toBe(401);
  });

  it('200 for a token issued in the same second as the change (iat has no finer grain)', async () => {
    const g = await userGrant();
    await getTestDb()`UPDATE users SET tokens_valid_after = to_timestamp(${g.iat}) WHERE id = ${g.userId}`;
    expect((await g.call()).status).toBe(200);
  });

  it('401 for a client_credentials token whose client is revoked', async () => {
    const sql = getTestDb();
    const c = await createOAuthClient(sql, {
      name: 'gd-cc-revoked', redirectUris: [],
      grantTypes: ['client_credentials'], scopes: ['market:read'],
      createdBy: null, public: false,
    });
    const at = await signAccessToken(env, { clientId: c.clientId, userId: null, scopes: ['market:read'] });
    const call = () => buildApp(['market:read']).request('/ok', {
      headers: { authorization: `Bearer ${at}` },
    }, env);
    expect((await call()).status).toBe(200);
    await revokeOAuthClient(sql, c.clientId);
    expect((await call()).status).toBe(401);
  });
});
