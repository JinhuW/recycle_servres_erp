import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { createOAuthClient } from '../src/oauth/clients';
import {
  generateSigningKey, signAccessToken, verifyAccessToken,
  issueRefreshToken, rotateRefreshToken, revokeRefreshFamily,
} from '../src/oauth/tokens';
import { deactivateMember } from '../src/services/members';

const env = (overrides: Record<string, string> = {}) => ({
  OAUTH_ISSUER_URL: 'https://erp.test',
  OAUTH_SIGNING_KEY_CURRENT: process.env.__TEST_KEY__,
  OAUTH_ACCESS_TOKEN_TTL_SEC: '60',
  OAUTH_REFRESH_TOKEN_TTL_SEC: '3600',
  ...overrides,
} as any);

describe('oauth tokens', () => {
  beforeAll(async () => {
    await resetDb();
    process.env.__TEST_KEY__ = await generateSigningKey();
  });

  async function aClient() {
    const db = getTestDb();
    const u = (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    return createOAuthClient(db, {
      name: 'tk', redirectUris: ['https://x/cb'],
      grantTypes: ['authorization_code','refresh_token'], scopes: ['market:read'],
      createdBy: u, public: false,
    });
  }

  it('signs an access token and verifies it back', async () => {
    const c = await aClient();
    const at = await signAccessToken(env(), {
      clientId: c.clientId, userId: '00000000-0000-0000-0000-000000000001',
      scopes: ['market:read'],
    });
    const claims = await verifyAccessToken(env(), at);
    expect(claims?.cid).toBe(c.clientId);
    expect(claims?.scopes).toEqual(['market:read']);
    expect(claims?.iss).toBe('https://erp.test');
  });

  it('rejects an access token signed with a different key', async () => {
    const c = await aClient();
    const at = await signAccessToken(env(), {
      clientId: c.clientId, userId: null, scopes: ['market:write'],
    });
    const otherKey = await generateSigningKey();
    const e2 = env({ OAUTH_SIGNING_KEY_CURRENT: otherKey, OAUTH_SIGNING_KEY_PREVIOUS: '' });
    expect(await verifyAccessToken(e2, at)).toBeNull();
  });

  it('verifies tokens signed with the PREVIOUS key when CURRENT rotated', async () => {
    const c = await aClient();
    const oldKey = process.env.__TEST_KEY__!;
    const at = await signAccessToken(env(), {
      clientId: c.clientId, userId: null, scopes: ['market:read'],
    });
    const newKey = await generateSigningKey();
    const e2 = env({ OAUTH_SIGNING_KEY_CURRENT: newKey, OAUTH_SIGNING_KEY_PREVIOUS: oldKey });
    const claims = await verifyAccessToken(e2, at);
    expect(claims).not.toBeNull();
  });

  it('rotateRefreshToken detects reuse and revokes the family', async () => {
    const db = getTestDb();
    const c = await aClient();
    const u = (await db<{ id: string }[]>`SELECT id FROM users WHERE active LIMIT 1`)[0].id;
    const r1 = await issueRefreshToken(db, env(), {
      clientId: c.clientId, userId: u, scopes: ['market:read'],
    });
    const r2 = await rotateRefreshToken(db, env(), r1.raw);
    expect(r2.ok).toBe(true);
    const reuse = await rotateRefreshToken(db, env(), r1.raw);
    expect(reuse.ok).toBe(false);
    // The just-issued r2 token is now revoked transitively.
    if (r2.ok) {
      const after = await rotateRefreshToken(db, env(), r2.raw);
      expect(after.ok).toBe(false);
    }
  });

  it('issueRefreshToken with null userId works (client_credentials)', async () => {
    const db = getTestDb();
    const c = await aClient();
    const r = await issueRefreshToken(db, env(), {
      clientId: c.clientId, userId: null, scopes: ['market:write'],
    });
    expect(r.raw).toMatch(/^[a-f0-9]{64}$/);
  });

  async function freshUser(role: 'manager' | 'purchaser'): Promise<string> {
    const db = getTestDb();
    const tag = crypto.randomUUID().slice(0, 8);
    const r = await db<{ id: string }[]>`
      INSERT INTO users (email, name, initials, role, password_hash, active)
      VALUES (${`oauth-${tag}@test.local`}, 'OAuth Test', 'OT', ${role}, 'x', TRUE)
      RETURNING id
    `;
    return r[0].id;
  }

  it('rotation refuses a deactivated user and kills the family for good', async () => {
    const db = getTestDb();
    const c = await aClient();
    const u = await freshUser('manager');
    const r1 = await issueRefreshToken(db, env(), {
      clientId: c.clientId, userId: u, scopes: ['market:read'],
    });
    await db`UPDATE users SET active = FALSE WHERE id = ${u}`;
    expect((await rotateRefreshToken(db, env(), r1.raw)).ok).toBe(false);
    // Reactivation must not resurrect the grant — the family was revoked.
    await db`UPDATE users SET active = TRUE WHERE id = ${u}`;
    expect((await rotateRefreshToken(db, env(), r1.raw)).ok).toBe(false);
  });

  it('rotation drops :write scopes for a demoted manager', async () => {
    const db = getTestDb();
    const c = await aClient();
    const u = await freshUser('manager');
    const r1 = await issueRefreshToken(db, env(), {
      clientId: c.clientId, userId: u, scopes: ['market:read', 'market:write'],
    });
    await db`UPDATE users SET role = 'purchaser' WHERE id = ${u}`;
    const res = await rotateRefreshToken(db, env(), r1.raw);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.scopes).toEqual(['market:read']);
  });

  it('deactivateMember revokes OAuth grants alongside cookie sessions', async () => {
    const db = getTestDb();
    const c = await aClient();
    const u = await freshUser('purchaser');
    const r1 = await issueRefreshToken(db, env(), {
      clientId: c.clientId, userId: u, scopes: ['market:read'],
    });
    await deactivateMember(db, u);
    expect((await rotateRefreshToken(db, env(), r1.raw)).ok).toBe(false);
  });
});
