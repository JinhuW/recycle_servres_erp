import { Hono } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Env, OAuthScope, User } from '../types';
import { authorizationServerMetadata, protectedResourceMetadata, resolvePublicOrigin, dcrEnabled } from './metadata';
import { getDb } from '../db';
import { authMiddleware, verifyToken } from '../auth';
import { createOAuthClient, findOAuthClient, verifyClientSecret, listOAuthClients, revokeOAuthClient } from './clients';
import { verifyChallenge } from './pkce';
import { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeRefreshFamily, dropWriteUnlessManager } from './tokens';
import { oauthGrantsTotal } from '../metrics';

const CODE_TTL_SEC = 600;
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

const KNOWN_SCOPES = new Set<string>(['market:read', 'market:write', 'sellorder:read', 'sellorder:write']);
// :write scopes through the interactive code flow are reserved for managers; a
// non-manager's consent yields a read-only grant. Service clients still get
// write via the admin-minted client_credentials path. The same rule is
// re-applied on refresh rotation (see oauth/tokens.ts).

const wellKnown = new Hono<{ Bindings: Env; Variables: { user: User } }>();

type WellKnownCtx = Context<{ Bindings: Env; Variables: { user: User } }>;
const asMeta = (c: WellKnownCtx) =>
  c.json(authorizationServerMetadata(resolvePublicOrigin(c), { dcr: dcrEnabled(c.env) }));
const prsMeta = (c: WellKnownCtx) => c.json(protectedResourceMetadata(resolvePublicOrigin(c)));

wellKnown.get('/oauth-authorization-server', asMeta);
wellKnown.get('/oauth-protected-resource', prsMeta);

// RFC 9728 §3.1 inserts the resource's path into the well-known URL, so the
// metadata for `https://host/api/mcp` lives at
// `/.well-known/oauth-protected-resource/api/mcp`. MCP clients probe that form
// first and only some of them fall back to the bare path. Registered as a
// literal rather than a wildcard so we can never advertise a resource we don't
// actually host, and so the Prometheus `route` label stays bounded.
wellKnown.get('/oauth-protected-resource/api/mcp', prsMeta);
// RFC 8414 §3.1's equivalent path-insertion form. Our issuer has no path
// component, so the bare URL above is the canonical one and this exists only
// because clients walk the same suffixed chain for the AS document.
wellKnown.get('/oauth-authorization-server/api/mcp', asMeta);

export default wellKnown;

// ── /oauth/* ────────────────────────────────────────────────────────────────

export const oauth = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;  // RFC 6749 §3.1.2 — redirect URIs carry no fragment.
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname)) return true;
    return false;
  } catch { return false; }
}

// RFC 8252 §7.3: a native app binds an ephemeral loopback port it can't know at
// registration time, so the AS must compare loopback redirect URIs ignoring the
// port. Claude Code is exactly this case — register `http://localhost/callback`
// once and every run's random port matches. Everything else stays an exact
// string comparison.
//
// This governs only the registration allowlist. The token endpoint separately
// re-checks redirect_uri against the concrete value recorded on the
// authorization code, which already carries the real port — RFC 6749 §4.1.3
// requires that one to stay exact, so don't route it through here.
export function redirectUriMatches(registered: string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let p: URL;
  try { p = new URL(presented); } catch { return false; }
  if (p.protocol !== 'http:' || !LOOPBACK_HOSTS.has(p.hostname) || p.hash) return false;
  return registered.some((r) => {
    let u: URL;
    try { u = new URL(r); } catch { return false; }
    return u.protocol === 'http:'
      // localhost and 127.0.0.1 stay distinct — they're different hosts to a
      // cookie jar, so register whichever the client actually uses.
      && u.hostname === p.hostname
      && u.pathname === p.pathname
      && u.search === p.search;
  });
}

// Registration is unauthenticated by design (RFC 7591), so it needs its own
// brakes. Registering grants no access, but unchecked it would let anyone fill
// oauth_clients and bury the real connectors in the Settings list.
const DCR_PER_IP_HOUR = 10;
const DCR_GLOBAL_HOUR = 60;
const DCR_UNUSED_CAP = 200;

oauth.post('/register', async (c) => {
  if (!dcrEnabled(c.env)) {
    return c.json({ error: 'registration disabled' }, 403);
  }
  const sql = getDb(c.env);
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')?.trim()
    || null;
  // Counted before any work, mirroring the windowed-COUNT throttle on login.
  // `unused` reclaims the case where a script registers repeatedly but never
  // completes a flow — those clients never mint a refresh token.
  const [counts] = await sql<{ per_ip: number; global_n: number; unused: number }[]>`
    SELECT
      COUNT(*) FILTER (
        WHERE created_ip IS NOT DISTINCT FROM ${ip}
          AND created_at > NOW() - INTERVAL '1 hour'
      )::int AS per_ip,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS global_n,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM oauth_refresh_tokens rt WHERE rt.client_id = oauth_clients.id
        )
      )::int AS unused
    FROM oauth_clients
    WHERE created_by IS NULL AND revoked_at IS NULL
  `;
  if ((ip !== null && counts.per_ip >= DCR_PER_IP_HOUR)
    || counts.global_n >= DCR_GLOBAL_HOUR
    || counts.unused >= DCR_UNUSED_CAP) {
    c.header('Retry-After', '3600');
    return c.json({
      error: 'temporarily_unavailable',
      error_description: 'registration rate limit reached',
    }, 429);
  }
  const body = (await c.req.json().catch(() => null)) as null | {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    scope?: string;
    token_endpoint_auth_method?: string;
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
  // Narrow to the advertised scope set, but keep market:write: registration
  // alone grants nothing — a DCR client can only mint a token through the
  // interactive code flow, where market:write survives only if the consenting
  // user is a manager (see /authorize + /authorize/consent). RFC 7591 §3.2.1
  // lets the AS return a narrower scope than requested.
  //
  // A client that names no scope gets all of them. Defaulting to market:read
  // silently hid the sell-order and write tools from every connector that
  // registered without asking, which reads as "the server only has two tools"
  // rather than as a permissions issue.
  const requested = body.scope?.split(' ').filter(Boolean) ?? [...KNOWN_SCOPES];
  const scopes = requested.filter(s => KNOWN_SCOPES.has(s));
  if (scopes.length === 0) scopes.push(...KNOWN_SCOPES);
  // token_endpoint_auth_method: "none" = public client (PKCE only, no secret).
  // Honour it so the SDK that asked for it isn't handed a secret it'll discard.
  const authMethod = body.token_endpoint_auth_method === 'none' ? 'none'
    : body.token_endpoint_auth_method === 'client_secret_post' ? 'client_secret_post'
    : 'client_secret_basic';
  const isPublic = authMethod === 'none';
  const out = await createOAuthClient(sql, {
    name: body.client_name,
    redirectUris: body.redirect_uris,
    grantTypes: grants,
    scopes,
    createdBy: null,
    createdIp: ip,
    public: isPublic,
  });
  return c.json({
    client_id: out.clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    // client_secret_expires_at is REQUIRED alongside a secret (RFC 7591
    // §3.2.1); 0 means it never expires. Strict registrants reject the
    // response without it.
    ...(out.clientSecret
      ? { client_secret: out.clientSecret, client_secret_expires_at: 0 }
      : {}),
    client_name: body.client_name,
    redirect_uris: body.redirect_uris,
    grant_types: grants,
    response_types: ['code'],
    scope: scopes.join(' '),
    token_endpoint_auth_method: authMethod,
  }, 201);
});

oauth.get('/authorize', async (c) => {
  const q = c.req.query();
  if (!q.client_id) return c.json({ error: 'invalid_request', detail: 'client_id required' }, 400);
  const sql = getDb(c.env);
  const client = await findOAuthClient(sql, q.client_id);
  if (!client) return c.json({ error: 'invalid_client' }, 400);
  if (!q.redirect_uri || !redirectUriMatches(client.redirect_uris, q.redirect_uri)) {
    // Echo what was presented — it's the caller's own input, so nothing leaks,
    // and a connector whose callback URL we guessed wrong is otherwise a silent
    // dead end for whoever has to fix the client's registration.
    return c.json({
      error: 'invalid_redirect_uri',
      presented: q.redirect_uri ?? null,
    }, 400);
  }
  // Per RFC 6749 §4.1.2.1, once client_id + redirect_uri are validated,
  // subsequent errors must redirect back so the client sees a structured
  // error rather than a 400 page.
  const redirectWithError = (code: string) => {
    const u = new URL(q.redirect_uri!);
    u.searchParams.set('error', code);
    if (q.state) u.searchParams.set('state', q.state);
    return c.redirect(u.toString(), 302);
  };
  if (q.response_type !== 'code') return redirectWithError('unsupported_response_type');
  if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
    return redirectWithError('invalid_request');
  }
  // Narrow rather than reject: an MCP SDK may request the union of
  // scopes_supported (market:read + market:write). Drop scopes the client
  // wasn't registered for; only fail if nothing remains. RFC 6749 §3.3 permits
  // a narrower granted scope.
  const requestedRaw = (q.scope ?? '').split(' ').filter(Boolean);
  const requested = requestedRaw.length === 0
    ? [...client.scopes]
    : requestedRaw.filter(s => client.scopes.includes(s));
  if (requested.length === 0) return redirectWithError('invalid_scope');
  const at = getCookie(c, 'at');
  if (!at) {
    const next = encodeURIComponent('/oauth/authorize?' + new URLSearchParams(q).toString());
    return c.redirect(`/login?next=${next}`, 302);
  }
  const payload = await verifyToken(c.env, at);
  if (!payload) {
    const next = encodeURIComponent('/oauth/authorize?' + new URLSearchParams(q).toString());
    return c.redirect(`/login?next=${next}`, 302);
  }
  // Gate market:write on the consenter's role so the consent screen shows the
  // scope that will actually be granted. The role here comes from the 15-min
  // `at` JWT; /authorize/consent re-checks it against the live DB record.
  const granted = dropWriteUnlessManager(requested, payload.role);
  if (granted.length === 0) return redirectWithError('invalid_scope');
  // Park the request server-side; hand the SPA an opaque handle so the long
  // PKCE challenge stays out of the URL on the consent screen.
  const req = randomBytes(16).toString('hex');
  await sql`
    INSERT INTO oauth_pending_consent (req, client_id, redirect_uri, scopes, code_challenge, state, expires_at, user_id_from_cookie)
    VALUES (${req}, ${q.client_id}, ${q.redirect_uri}, ${granted}, ${q.code_challenge}, ${q.state ?? null},
            NOW() + INTERVAL '10 minutes', ${payload.sub})
  `;
  return c.redirect(`/authorize?req=${req}`, 302);
});

oauth.post('/authorize/consent', authMiddleware, async (c) => {
  const body = (await c.req.json().catch(() => null)) as null | { req?: string };
  if (!body?.req) return c.json({ error: 'invalid_request', detail: 'req required' }, 400);
  // Capture into a local so the narrowed string survives the async closure.
  const reqHandle = body.req;
  const sql = getDb(c.env);
  const user = c.var.user;

  type Outcome =
    | { ok: true; redirectUri: string; code: string; state: string | null }
    | { ok: false; status: 400 | 404; error: string };

  const result: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const row = (await tx`
      SELECT client_id, redirect_uri, scopes, code_challenge, state,
             user_id_from_cookie, (expires_at <= NOW()) AS expired
      FROM oauth_pending_consent
      WHERE req = ${reqHandle}
      FOR UPDATE
      LIMIT 1
    `)[0] as {
      client_id: string; redirect_uri: string; scopes: string[];
      code_challenge: string; state: string | null;
      user_id_from_cookie: string | null; expired: boolean;
    } | undefined;
    if (!row) return { ok: false, status: 404, error: 'expired_or_unknown' };
    if (row.expired) return { ok: false, status: 404, error: 'expired_or_unknown' };
    if (row.user_id_from_cookie !== user.id) {
      return { ok: false, status: 400, error: 'user_mismatch' };
    }
    // Authoritative scope gate: the pending row was frozen at /authorize using
    // the JWT's role; re-derive against the live DB role so a demotion (or a
    // tampered row) can't leak market:write to a non-manager.
    const scopes = dropWriteUnlessManager(row.scopes, user.role);
    const code = randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + CODE_TTL_SEC * 1000);
    await tx`
      INSERT INTO oauth_authorization_codes
        (code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, expires_at)
      VALUES
        (${sha256hex(code)}, ${row.client_id}, ${user.id}, ${row.redirect_uri},
         ${scopes}, ${row.code_challenge}, ${expires})
    `;
    await tx`DELETE FROM oauth_pending_consent WHERE req = ${reqHandle}`;
    return { ok: true, redirectUri: row.redirect_uri, code, state: row.state };
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const url = new URL(result.redirectUri);
  url.searchParams.set('code', result.code);
  if (result.state) url.searchParams.set('state', result.state);
  const target = url.toString();
  if ((c.req.header('accept') ?? '').includes('application/json')) {
    return c.json({ redirectUri: target });
  }
  return c.redirect(target, 302);
});

// RFC 6749 §4.1.2.1 access_denied: explicit deny path so the OAuth client sees
// a structured error rather than a hung redirect when the user refuses.
oauth.post('/authorize/deny', authMiddleware, async (c) => {
  const body = (await c.req.json().catch(() => null)) as null | { req?: string };
  if (!body?.req) return c.json({ error: 'invalid_request', detail: 'req required' }, 400);
  const reqHandle = body.req;
  const sql = getDb(c.env);
  const user = c.var.user;

  type Outcome =
    | { ok: true; redirectUri: string; state: string | null }
    | { ok: false; status: 400 | 404; error: string };

  const result: Outcome = await sql.begin(async (tx): Promise<Outcome> => {
    const row = (await tx<{
      redirect_uri: string; state: string | null;
      user_id_from_cookie: string | null; expired: boolean;
    }[]>`
      SELECT redirect_uri, state, user_id_from_cookie,
             (expires_at <= NOW()) AS expired
      FROM oauth_pending_consent
      WHERE req = ${reqHandle}
      FOR UPDATE
      LIMIT 1
    `)[0];
    if (!row || row.expired) return { ok: false, status: 404, error: 'expired_or_unknown' };
    if (row.user_id_from_cookie !== user.id) {
      return { ok: false, status: 400, error: 'user_mismatch' };
    }
    await tx`DELETE FROM oauth_pending_consent WHERE req = ${reqHandle}`;
    return { ok: true, redirectUri: row.redirect_uri, state: row.state };
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  const url = new URL(result.redirectUri);
  url.searchParams.set('error', 'access_denied');
  if (result.state) url.searchParams.set('state', result.state);
  const target = url.toString();
  if ((c.req.header('accept') ?? '').includes('application/json')) {
    return c.json({ redirectUri: target });
  }
  return c.redirect(target, 302);
});

// ── /oauth/token helpers ────────────────────────────────────────────────────

type ParsedClientCreds = { id: string; secret: string | null };

function readClientCreds(
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
  body: Record<string, string>,
): ParsedClientCreds | null {
  const authz = c.req.header('authorization');
  if (authz?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authz.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) {
        return {
          id: decodeURIComponent(decoded.slice(0, i)),
          secret: decodeURIComponent(decoded.slice(i + 1)),
        };
      }
    } catch { /* malformed Basic header — fall through */ }
  }
  if (body.client_id) {
    return { id: body.client_id, secret: body.client_secret ?? null };
  }
  return null;
}

async function readFormBody(
  c: Context<{ Bindings: Env; Variables: { user: User } }>,
): Promise<Record<string, string>> {
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('application/json')) return await c.req.json();
  const text = await c.req.text();
  return Object.fromEntries(new URLSearchParams(text)) as Record<string, string>;
}

oauth.post('/token', async (c) => {
  const env = c.env;
  const sql = getDb(env);
  const form = await readFormBody(c);
  const creds = readClientCreds(c, form);
  // Failed-mint counter: label with the requested grant_type if known, else
  // 'unknown' for top-of-handler rejects (no client/secret means we never
  // got far enough to commit to a particular grant flow).
  const labelGrant = (form.grant_type || 'unknown') as string;
  if (!creds) {
    oauthGrantsTotal.inc({ grant_type: labelGrant, status: 'error' });
    return c.json({ error: 'invalid_client' }, 401);
  }

  const client = await findOAuthClient(sql, creds.id);
  if (!client) {
    oauthGrantsTotal.inc({ grant_type: labelGrant, status: 'error' });
    return c.json({ error: 'invalid_client' }, 401);
  }

  if (client.secret_hash) {
    if (!creds.secret || !(await verifyClientSecret(client, creds.secret))) {
      oauthGrantsTotal.inc({ grant_type: labelGrant, status: 'error' });
      return c.json({ error: 'invalid_client' }, 401);
    }
  }

  const grant = form.grant_type;

  if (grant === 'authorization_code') {
    if (!client.grant_types.includes('authorization_code')) {
      oauthGrantsTotal.inc({ grant_type: 'authorization_code', status: 'error' });
      return c.json({ error: 'unauthorized_client' }, 400);
    }
    const { code, code_verifier, redirect_uri } = form;
    if (!code || !code_verifier || !redirect_uri) {
      oauthGrantsTotal.inc({ grant_type: 'authorization_code', status: 'error' });
      return c.json({ error: 'invalid_request' }, 400);
    }
    type CodeRow = {
      client_id: string; user_id: string; redirect_uri: string;
      scopes: OAuthScope[]; code_challenge: string;
    };
    const row = await sql.begin<CodeRow | null>(async (tx): Promise<CodeRow | null> => {
      const r = (await tx<{
        client_id: string; user_id: string; redirect_uri: string;
        scopes: OAuthScope[]; code_challenge: string; expired: boolean;
        consumed_at: Date | null;
      }[]>`
        SELECT client_id, user_id, redirect_uri, scopes, code_challenge,
               (expires_at <= NOW()) AS expired, consumed_at
        FROM oauth_authorization_codes
        WHERE code_hash = ${sha256hex(code)}
        FOR UPDATE
        LIMIT 1
      `)[0];
      if (!r || r.consumed_at || r.expired) return null;
      if (r.client_id !== client.id) return null;
      // Stays an exact comparison even for loopback clients (RFC 6749 §4.1.3):
      // this is against the concrete URI recorded at /authorize, which already
      // carries the real ephemeral port. Don't route it through
      // redirectUriMatches — that would let a code minted for one port be
      // redeemed against another.
      if (r.redirect_uri !== redirect_uri) return null;
      if (!verifyChallenge(r.code_challenge, code_verifier)) return null;
      await tx`
        UPDATE oauth_authorization_codes
        SET consumed_at = NOW()
        WHERE code_hash = ${sha256hex(code)}
      `;
      return {
        client_id: r.client_id, user_id: r.user_id, redirect_uri: r.redirect_uri,
        scopes: r.scopes, code_challenge: r.code_challenge,
      };
    });
    if (!row) {
      oauthGrantsTotal.inc({ grant_type: 'authorization_code', status: 'error' });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    const at = await signAccessToken(env, {
      clientId: client.id, userId: row.user_id, scopes: row.scopes,
    });
    const rt = client.grant_types.includes('refresh_token')
      ? await issueRefreshToken(sql, env, {
          clientId: client.id, userId: row.user_id, scopes: row.scopes,
        })
      : null;
    oauthGrantsTotal.inc({ grant_type: 'authorization_code', status: 'ok' });
    return c.json({
      access_token: at,
      token_type: 'Bearer',
      expires_in: Number.parseInt(env.OAUTH_ACCESS_TOKEN_TTL_SEC ?? '900', 10),
      refresh_token: rt?.raw,
      scope: row.scopes.join(' '),
    });
  }

  if (grant === 'refresh_token') {
    if (!client.grant_types.includes('refresh_token')) {
      oauthGrantsTotal.inc({ grant_type: 'refresh_token', status: 'error' });
      return c.json({ error: 'unauthorized_client' }, 400);
    }
    const raw = form.refresh_token;
    if (!raw) {
      oauthGrantsTotal.inc({ grant_type: 'refresh_token', status: 'error' });
      return c.json({ error: 'invalid_request' }, 400);
    }
    const res = await rotateRefreshToken(sql, env, raw);
    if (!res.ok) {
      oauthGrantsTotal.inc({ grant_type: 'refresh_token', status: 'error' });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    if (res.clientId !== client.id) {
      oauthGrantsTotal.inc({ grant_type: 'refresh_token', status: 'error' });
      return c.json({ error: 'invalid_grant' }, 400);
    }
    const at = await signAccessToken(env, {
      clientId: client.id, userId: res.userId, scopes: res.scopes,
    });
    oauthGrantsTotal.inc({ grant_type: 'refresh_token', status: 'ok' });
    return c.json({
      access_token: at,
      token_type: 'Bearer',
      expires_in: Number.parseInt(env.OAUTH_ACCESS_TOKEN_TTL_SEC ?? '900', 10),
      refresh_token: res.raw,
      scope: res.scopes.join(' '),
    });
  }

  if (grant === 'client_credentials') {
    if (!client.grant_types.includes('client_credentials')) {
      oauthGrantsTotal.inc({ grant_type: 'client_credentials', status: 'error' });
      return c.json({ error: 'unauthorized_client' }, 400);
    }
    if (!client.secret_hash) {
      oauthGrantsTotal.inc({ grant_type: 'client_credentials', status: 'error' });
      return c.json({ error: 'invalid_client', detail: 'client_credentials requires a confidential client' }, 401);
    }
    const requested = (form.scope ?? '').split(' ').filter(Boolean);
    if (requested.length === 0) {
      oauthGrantsTotal.inc({ grant_type: 'client_credentials', status: 'error' });
      return c.json({ error: 'invalid_scope' }, 400);
    }
    for (const s of requested) {
      if (!client.scopes.includes(s)) {
        oauthGrantsTotal.inc({ grant_type: 'client_credentials', status: 'error' });
        return c.json({ error: 'invalid_scope' }, 400);
      }
    }
    const at = await signAccessToken(env, {
      clientId: client.id, userId: null, scopes: requested as OAuthScope[],
    });
    oauthGrantsTotal.inc({ grant_type: 'client_credentials', status: 'ok' });
    return c.json({
      access_token: at,
      token_type: 'Bearer',
      expires_in: Number.parseInt(env.OAUTH_ACCESS_TOKEN_TTL_SEC ?? '900', 10),
      scope: requested.join(' '),
    });
  }

  // unsupported_grant_type: skip counter — labels assume a known grant_type
  // and we don't want to mint an 'unknown'-labeled series for malformed input.
  return c.json({ error: 'unsupported_grant_type' }, 400);
});

// RFC 7009 token revocation. Returns 200 even when the token is unknown so a
// client can blindly revoke without leaking which tokens exist.
oauth.post('/revoke', async (c) => {
  const form = await readFormBody(c);
  const creds = readClientCreds(c, form);
  if (!creds) return c.json({ error: 'invalid_client' }, 401);
  const sql = getDb(c.env);
  const client = await findOAuthClient(sql, creds.id);
  if (!client) return c.json({ error: 'invalid_client' }, 401);
  if (client.secret_hash && !(await verifyClientSecret(client, creds.secret ?? ''))) {
    return c.json({ error: 'invalid_client' }, 401);
  }
  const raw = form.token;
  if (!raw) return c.json({}, 200);
  const row = (await sql<{ family_id: string; client_id: string }[]>`
    SELECT family_id, client_id FROM oauth_refresh_tokens
    WHERE token_hash = ${sha256hex(raw)} LIMIT 1
  `)[0];
  if (row && row.client_id === client.id) {
    await revokeRefreshFamily(sql, row.family_id, 'manual');
  }
  return c.json({}, 200);
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

// ── /api/oauth/clients (admin) ──────────────────────────────────────────────
// Cookie-authed, manager-only. Surfaces the OAuth client list to the Settings
// > Connectors tab and lets managers mint service clients (for the market
// scraper) or revoke existing ones. The mutating verbs go through csrfGuard
// like every other /api/* route — this surface is NOT exempt.
const VALID_GRANT_TYPES = ['authorization_code', 'refresh_token', 'client_credentials'] as const;
const VALID_SCOPES = ['market:read', 'market:write', 'sellorder:read', 'sellorder:write'] as const;

export const oauthAdmin = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', async (c, next) => {
    if (c.var.user.role !== 'manager') return c.json({ error: 'forbidden' }, 403);
    return next();
  })
  .get('/', async (c) => {
    const sql = getDb(c.env);
    const rows = await listOAuthClients(sql);
    // Separate aggregate keeps listOAuthClients pure — admin UI is the only
    // surface that wants last_used_at, so the join doesn't belong in the helper.
    const lastUsed = await sql<{ client_id: string; last_used_at: Date }[]>`
      SELECT client_id, MAX(created_at) AS last_used_at
      FROM oauth_refresh_tokens
      WHERE revoked_at IS NULL
      GROUP BY client_id
    `;
    const lastUsedByClient = new Map(lastUsed.map(r => [r.client_id, r.last_used_at]));
    return c.json({
      clients: rows.map(r => ({
        id: r.id,
        name: r.name,
        scopes: r.scopes,
        grantTypes: r.grant_types,
        createdAt: r.created_at,
        lastUsedAt: lastUsedByClient.get(r.id) ?? null,
      })),
    });
  })
  .post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as null | {
      name?: string;
      redirectUris?: string[];
      grantTypes?: string[];
      scopes?: string[];
      public?: boolean;
    };
    if (!body?.name) return c.json({ error: 'name required' }, 400);
    const grantTypes = body.grantTypes ?? ['client_credentials'];
    const scopes = body.scopes ?? ['market:read'];
    for (const g of grantTypes) {
      if (!VALID_GRANT_TYPES.includes(g as typeof VALID_GRANT_TYPES[number])) {
        return c.json({ error: `invalid grant_type: ${g}` }, 400);
      }
    }
    for (const s of scopes) {
      if (!VALID_SCOPES.includes(s as typeof VALID_SCOPES[number])) {
        return c.json({ error: `invalid scope: ${s}` }, 400);
      }
    }
    // Same allowlist DCR enforces — being a manager shouldn't buy the ability to
    // point a client at a javascript: or data: URI.
    const redirectUris = body.redirectUris ?? [];
    for (const r of redirectUris) {
      if (!isValidRedirectUri(r)) return c.json({ error: `invalid redirect_uri: ${r}` }, 400);
    }
    // A connector client with no callback can never complete a code flow, so
    // reject it here rather than at the first confusing /authorize 400.
    if (grantTypes.includes('authorization_code') && redirectUris.length === 0) {
      return c.json({ error: 'redirectUris required for authorization_code clients' }, 400);
    }
    const out = await createOAuthClient(getDb(c.env), {
      name: body.name,
      redirectUris,
      grantTypes,
      scopes,
      createdBy: c.var.user.id,
      public: body.public ?? false,
    });
    return c.json({ ...out, name: body.name, grantTypes, scopes, redirectUris }, 201);
  })
  .delete('/:id', async (c) => {
    await revokeOAuthClient(getDb(c.env), c.req.param('id'));
    return c.json({ ok: true });
  });
