import { Hono } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { getCookie } from 'hono/cookie';
import type { Env, User } from '../types';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';
import { getDb } from '../db';
import { authMiddleware } from '../auth';
import { createOAuthClient, findOAuthClient } from './clients';

const CODE_TTL_SEC = 600;
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

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
  }, 201);
});

oauth.get('/authorize', async (c) => {
  const q = c.req.query();
  if (!q.client_id) return c.json({ error: 'invalid_request', detail: 'client_id required' }, 400);
  const sql = getDb(c.env);
  const client = await findOAuthClient(sql, q.client_id);
  if (!client) return c.json({ error: 'invalid_client' }, 400);
  if (q.response_type !== 'code') return c.json({ error: 'unsupported_response_type' }, 400);
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
    return c.json({ error: 'invalid_redirect_uri' }, 400);
  }
  if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
    return c.json({ error: 'invalid_request', detail: 'PKCE S256 required' }, 400);
  }
  const requested = (q.scope ?? '').split(' ').filter(Boolean);
  for (const s of requested) {
    if (!client.scopes.includes(s)) {
      return c.json({ error: 'invalid_scope', detail: `client lacks scope ${s}` }, 400);
    }
  }
  if (!getCookie(c, 'at')) {
    const next = encodeURIComponent('/oauth/authorize?' + new URLSearchParams(q).toString());
    return c.redirect(`/login?next=${next}`, 302);
  }
  // Park the request server-side; hand the SPA an opaque handle so the long
  // PKCE challenge stays out of the URL on the consent screen.
  const req = randomBytes(16).toString('hex');
  await sql`
    INSERT INTO oauth_pending_consent (req, client_id, redirect_uri, scopes, code_challenge, state, expires_at, user_id_from_cookie)
    VALUES (${req}, ${q.client_id}, ${q.redirect_uri}, ${requested}, ${q.code_challenge}, ${q.state ?? null},
            NOW() + INTERVAL '10 minutes', NULL)
  `;
  return c.redirect(`/authorize?req=${req}`, 302);
});

oauth.post('/authorize/consent', authMiddleware, async (c) => {
  const body = (await c.req.json().catch(() => null)) as null | {
    client_id?: string; redirect_uri?: string; scope?: string; state?: string;
    code_challenge?: string; code_challenge_method?: string;
  };
  if (!body) return c.json({ error: 'invalid_request' }, 400);
  const sql = getDb(c.env);
  const client = body.client_id ? await findOAuthClient(sql, body.client_id) : null;
  if (!client) return c.json({ error: 'invalid_client' }, 400);
  if (!body.redirect_uri || !client.redirect_uris.includes(body.redirect_uri)) {
    return c.json({ error: 'invalid_redirect_uri' }, 400);
  }
  if (body.code_challenge_method !== 'S256' || !body.code_challenge) {
    return c.json({ error: 'invalid_request' }, 400);
  }
  const user = c.var.user;
  const scopes = (body.scope ?? '').split(' ').filter(Boolean);
  const code = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + CODE_TTL_SEC * 1000);
  await sql`
    INSERT INTO oauth_authorization_codes
      (code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, expires_at)
    VALUES
      (${sha256hex(code)}, ${client.id}, ${user.id}, ${body.redirect_uri}, ${scopes},
       ${body.code_challenge}, ${expires})
  `;
  const url = new URL(body.redirect_uri);
  url.searchParams.set('code', code);
  if (body.state) url.searchParams.set('state', body.state);
  return c.redirect(url.toString(), 302);
});

oauth.get('/authorize/pending/:req', authMiddleware, async (c) => {
  const sql = getDb(c.env);
  const row = (await sql<{
    client_id: string; redirect_uri: string; scopes: string[];
    code_challenge: string; state: string | null;
  }[]>`
    SELECT client_id, redirect_uri, scopes, code_challenge, state
    FROM oauth_pending_consent
    WHERE req = ${c.req.param('req')} AND expires_at > NOW()
    LIMIT 1
  `)[0];
  if (!row) return c.json({ error: 'expired_or_unknown' }, 404);
  const client = await findOAuthClient(sql, row.client_id);
  if (!client) return c.json({ error: 'invalid_client' }, 400);
  return c.json({
    clientId: row.client_id,
    clientName: client.name,
    redirectUri: row.redirect_uri,
    scopes: row.scopes,
    codeChallenge: row.code_challenge,
    state: row.state,
  });
});
