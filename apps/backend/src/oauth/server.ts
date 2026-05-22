import { Hono } from 'hono';
import type { Env, User } from '../types';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';
import { getDb } from '../db';
import { createOAuthClient } from './clients';

const wellKnown = new Hono<{ Bindings: Env; Variables: { user: User } }>();

wellKnown.get('/oauth-authorization-server', (c) =>
  c.json(authorizationServerMetadata(c.env)),
);

wellKnown.get('/oauth-protected-resource', (c) =>
  c.json(protectedResourceMetadata(c.env)),
);

export default wellKnown;

// ── /oauth/* ────────────────────────────────────────────────────────────────

export const oauth = new Hono<{ Bindings: Env; Variables: { user: User } }>();

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    return false;
  } catch { return false; }
}

oauth.post('/register', async (c) => {
  if (c.env.OAUTH_DCR_OPEN !== 'true') {
    return c.json({ error: 'registration disabled' }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as null | {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    scope?: string;
  };
  if (!body?.client_name || !Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return c.json({ error: 'client_name and redirect_uris required' }, 400);
  }
  for (const r of body.redirect_uris) {
    if (!isValidRedirectUri(r)) return c.json({ error: `invalid redirect_uri: ${r}` }, 400);
  }
  const allowedGrants = new Set(['authorization_code', 'refresh_token']);
  const grants = (body.grant_types ?? ['authorization_code', 'refresh_token']).filter(g => allowedGrants.has(g));
  if (grants.length === 0) return c.json({ error: 'no allowed grant_types requested' }, 400);
  const scopes = (body.scope?.split(' ').filter(Boolean) ?? ['market:read']);
  for (const s of scopes) {
    if (s !== 'market:read') return c.json({ error: `scope ${s} not grantable via DCR` }, 400);
  }
  const sql = getDb(c.env);
  const out = await createOAuthClient(sql, {
    name: body.client_name,
    redirectUris: body.redirect_uris,
    grantTypes: grants,
    scopes,
    createdBy: null,
    public: false,
  });
  return c.json({
    client_id: out.clientId,
    client_secret: out.clientSecret,
    redirect_uris: body.redirect_uris,
    grant_types: grants,
    scope: scopes.join(' '),
    token_endpoint_auth_method: 'client_secret_basic',
  }, 201);
});
