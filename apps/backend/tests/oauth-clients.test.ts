import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient, findOAuthClient, verifyClientSecret, listOAuthClients, revokeOAuthClient } from '../src/oauth/clients';

describe('oauth_clients CRUD', () => {
  beforeAll(async () => { await resetDb(); });

  async function aUser(): Promise<string> {
    const db = getTestDb();
    return (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
  }

  it('creates a confidential client and returns secret only once', async () => {
    const db = getTestDb();
    const out = await createOAuthClient(db, {
      name: 'test confidential',
      redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code', 'refresh_token'],
      scopes: ['market:read'],
      createdBy: await aUser(),
      public: false,
    });
    expect(out.clientId).toMatch(/^[a-z0-9]{20,}$/);
    expect(out.clientSecret).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    const row = await findOAuthClient(db, out.clientId);
    expect(row?.name).toBe('test confidential');
    expect(row?.secret_hash).toBeTruthy();
  });

  it('verifyClientSecret compares against stored bcrypt hash', async () => {
    const db = getTestDb();
    const out = await createOAuthClient(db, {
      name: 'verify check',
      redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code'],
      scopes: ['market:read'],
      createdBy: await aUser(),
      public: false,
    });
    const row = await findOAuthClient(db, out.clientId);
    expect(await verifyClientSecret(row!, out.clientSecret)).toBe(true);
    expect(await verifyClientSecret(row!, 'wrong')).toBe(false);
  });

  it('creates a public client with no secret', async () => {
    const db = getTestDb();
    const out = await createOAuthClient(db, {
      name: 'public client',
      redirectUris: ['http://localhost:8080/cb'],
      grantTypes: ['authorization_code'],
      scopes: ['market:read'],
      createdBy: await aUser(),
      public: true,
    });
    expect(out.clientSecret).toBeNull();
    const row = await findOAuthClient(db, out.clientId);
    expect(row?.secret_hash).toBeNull();
  });

  it('revokeOAuthClient sets revoked_at and findOAuthClient returns null', async () => {
    const db = getTestDb();
    const uid = await aUser();
    const out = await createOAuthClient(db, {
      name: 'to revoke', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code'], scopes: ['market:read'],
      createdBy: uid, public: false,
    });
    await revokeOAuthClient(db, out.clientId);
    expect(await findOAuthClient(db, out.clientId)).toBeNull();
  });

  it('listOAuthClients hides revoked rows by default', async () => {
    const db = getTestDb();
    const before = (await listOAuthClients(db)).length;
    const uid = await aUser();
    const out = await createOAuthClient(db, {
      name: 'listed', redirectUris: ['https://example.com/cb'],
      grantTypes: ['authorization_code'], scopes: ['market:read'],
      createdBy: uid, public: false,
    });
    expect((await listOAuthClients(db)).length).toBe(before + 1);
    await revokeOAuthClient(db, out.clientId);
    expect((await listOAuthClients(db)).length).toBe(before);
  });
});
