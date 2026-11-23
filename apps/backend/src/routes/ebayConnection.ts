import { createHash, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { authMiddleware } from '../auth';
import { getDb } from '../db';
import { getIdentityUser, EbayClient } from '../ebay/client';
import { ebayConfig, ebayEnvironment } from '../ebay/config';
import {
  ebayFailure, ebayTokenCache, missingDefaults, pickAccountDefaults, type ConnectionRow,
} from '../ebay/connection';
import { consentUrl, EBAY_SCOPES, EbayOAuthError, exchangeCode } from '../ebay/oauth';
import { syncEbayOrders } from '../ebay/sync';
import { log } from '../lib/log';
import { requireManager } from '../lib/role';
import { ebayKey, seal } from '../lib/sealed';
import type { Env, User } from '../types';

// Settings ▸ eBay: the seller account the desk publishes to and the sync reads
// orders from. Manager-only. Mounted at /api/ebay ahead of routes/ebay.ts,
// whose router-wide role gate would otherwise run first; the OAuth callback is
// left out of the /api/ebay/* authMiddleware (index.ts) and checks the session
// itself, so an expired one lands back on the page instead of on a JSON 401.
// No response here ever carries a token.
const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();
const ebayLog = log.child({ module: 'ebay-oauth' });

const STATE_TTL_MIN = 10;
const RECONNECT_WARN_DAYS = 30;
const DAY_MS = 86_400_000;
// Lets the consent also name the seller's username. A token is only ever
// minted later for EBAY_SCOPES, which every call the ERP makes needs.
const IDENTITY_SCOPE = 'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly';

const hashState = (s: string) => createHash('sha256').update(s).digest('hex');

/** Where the callback sends the browser: the SPA's Settings ▸ eBay with an outcome flag. */
export const settingsUrl = (outcome: { ok: true } | { error: string }) =>
  '/#/settings?section=ebay&' + ('ok' in outcome ? 'ebay=connected' : `ebay=error&reason=${encodeURIComponent(outcome.error)}`);

async function connectionJson(c: Context<{ Bindings: Env; Variables: { user: User } }>) {
  const sql = getDb(c.env);
  const cfg = ebayConfig(c.env);
  const environment = ebayEnvironment(c.env);
  const [row] = await sql<(ConnectionRow & { connected_by_name: string | null })[]>`
    SELECT ec.*, u.name AS connected_by_name
    FROM ebay_connection ec LEFT JOIN users u ON u.id = ec.connected_by WHERE ec.id = 1
  `;
  const conn = row && row.environment === environment ? row : null;
  const now = Date.now();
  return {
    configured: cfg !== null,
    keyAvailable: ebayKey(c.env) !== null,
    environment,
    connected: conn !== null,
    // A row made with the other keyset: it has to be connected again here.
    otherEnvironment: row && !conn ? row.environment : null,
    account: conn ? { userId: conn.ebay_user_id, username: conn.ebay_username } : null,
    marketplaceId: conn?.marketplace_id ?? null,
    refreshTokenExpiresAt: conn?.refresh_token_expires_at ?? null,
    reconnectSoon: conn ? conn.refresh_token_expires_at.getTime() - now < RECONNECT_WARN_DAYS * DAY_MS : false,
    expired: conn ? conn.refresh_token_expires_at.getTime() <= now : false,
    defaults: conn ? {
      merchantLocationKey: conn.merchant_location_key,
      fulfillmentPolicyId: conn.fulfillment_policy_id,
      paymentPolicyId: conn.payment_policy_id,
      returnPolicyId: conn.return_policy_id,
    } : null,
    missingDefaults: conn ? missingDefaults(conn) : [],
    setupIssues: conn?.setup_issues ?? [],
    connectedAt: conn?.connected_at ?? null,
    connectedBy: conn?.connected_by ? { id: conn.connected_by, name: conn.connected_by_name } : null,
    sync: conn ? {
      lastSyncAt: conn.last_sync_at,
      lastError: conn.last_error,
      lastResult: conn.last_result,
      cursor: conn.sync_cursor,
    } : null,
  };
}

app.get('/connection', requireManager, async (c) => c.json(await connectionJson(c)));

// Forgets the account: the sealed token goes, and with it publishing and the
// sync. Listings keep their eBay item numbers.
app.delete('/connection', requireManager, async (c) => {
  await getDb(c.env)`DELETE FROM ebay_connection WHERE id = 1`;
  ebayTokenCache.clear();
  return c.json({ ok: true });
});

// A full-page navigation from the Connect button, so every refusal after the
// role check goes back to the page rather than leaving a JSON body on screen.
app.get('/oauth/start', requireManager, async (c) => {
  const cfg = ebayConfig(c.env);
  if (!cfg) return c.redirect(settingsUrl({ error: 'not_configured' }), 302);
  if (!ebayKey(c.env)) return c.redirect(settingsUrl({ error: 'no_key' }), 302);
  const state = randomBytes(32).toString('base64url');
  const sql = getDb(c.env);
  await sql`DELETE FROM ebay_oauth_states WHERE expires_at < NOW()`;
  await sql`
    INSERT INTO ebay_oauth_states (state_hash, user_id, expires_at)
    VALUES (${hashState(state)}, ${c.var.user.id}, NOW() + make_interval(mins => ${STATE_TTL_MIN}))
  `;
  return c.redirect(consentUrl(cfg, state, [...EBAY_SCOPES, IDENTITY_SCOPE]), 302);
});

// eBay sends the browser here (the RuName's accept and decline URLs) with
// `code` and `state`. The state must be one this server issued, unexpired,
// unused, and issued to the manager whose session is completing it.
app.get('/oauth/callback', async (c) => {
  let authed = false;
  await authMiddleware(c, async () => { authed = true; });
  if (!authed) return c.redirect(settingsUrl({ error: 'session' }), 302);
  const user = c.var.user;

  const state = c.req.query('state') ?? '';
  const sql = getDb(c.env);
  const [st] = state
    ? await sql<{ user_id: string; live: boolean }[]>`
        DELETE FROM ebay_oauth_states WHERE state_hash = ${hashState(state)}
        RETURNING user_id, expires_at > NOW() AS live
      `
    : [];
  if (!st || !st.live || st.user_id !== user.id) return c.redirect(settingsUrl({ error: 'state' }), 302);
  if (user.role !== 'manager') return c.redirect(settingsUrl({ error: 'forbidden' }), 302);
  const cfg = ebayConfig(c.env);
  const key = ebayKey(c.env);
  if (!cfg || !key) return c.redirect(settingsUrl({ error: 'not_configured' }), 302);
  const code = c.req.query('code');
  if (!code) return c.redirect(settingsUrl({ error: 'declined' }), 302);

  let tokens;
  try {
    tokens = await exchangeCode(cfg, code);
  } catch (e) {
    if (!(e instanceof EbayOAuthError) && !ebayFailure(e)) throw e;
    ebayLog.warn('code exchange refused', { error: e instanceof Error ? e.message : String(e) });
    return c.redirect(settingsUrl({ error: 'exchange' }), 302);
  }

  // Both best effort: a connection without a username or a default still
  // works, and the card says what is missing.
  let identity: { userId: string | null; username: string | null } = { userId: null, username: null };
  try {
    const u = await getIdentityUser(cfg, tokens.accessToken);
    identity = { userId: u.userId ?? null, username: u.username ?? null };
  } catch (e) {
    if (!ebayFailure(e)) throw e;
    ebayLog.warn('identity lookup failed', { error: e instanceof Error ? e.message : String(e) });
  }
  const client = new EbayClient({ cfg, getAccessToken: async () => tokens.accessToken });
  const defaults = await pickAccountDefaults(client);

  const environment = ebayEnvironment(c.env);
  await sql`
    INSERT INTO ebay_connection (
      id, environment, refresh_token_sealed, refresh_token_expires_at, ebay_user_id, ebay_username,
      merchant_location_key, fulfillment_policy_id, payment_policy_id, return_policy_id, setup_issues,
      connected_by, connected_at, updated_at)
    VALUES (
      1, ${environment}, ${seal(tokens.refreshToken, key)}, ${tokens.refreshTokenExpiresAt},
      ${identity.userId}, ${identity.username},
      ${defaults.merchantLocationKey}, ${defaults.fulfillmentPolicyId}, ${defaults.paymentPolicyId},
      ${defaults.returnPolicyId}, ${sql.json(defaults.issues as never)}, ${user.id}, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      environment = EXCLUDED.environment,
      refresh_token_sealed = EXCLUDED.refresh_token_sealed,
      refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
      ebay_user_id = EXCLUDED.ebay_user_id,
      ebay_username = EXCLUDED.ebay_username,
      merchant_location_key = EXCLUDED.merchant_location_key,
      fulfillment_policy_id = EXCLUDED.fulfillment_policy_id,
      payment_policy_id = EXCLUDED.payment_policy_id,
      return_policy_id = EXCLUDED.return_policy_id,
      setup_issues = EXCLUDED.setup_issues,
      connected_by = EXCLUDED.connected_by,
      connected_at = EXCLUDED.connected_at,
      updated_at = EXCLUDED.updated_at,
      -- Reconnecting the same account keeps its place in the order history;
      -- another account (or keyset) starts over.
      sync_cursor = CASE
        WHEN ebay_connection.environment = EXCLUDED.environment
         AND ebay_connection.ebay_user_id IS NOT DISTINCT FROM EXCLUDED.ebay_user_id
        THEN ebay_connection.sync_cursor END,
      last_error = NULL
  `;
  ebayTokenCache.clear();
  ebayLog.info('eBay account connected', {
    environment, username: identity.username, missingDefaults: defaults.issues.map((i) => i.field),
  });
  return c.redirect(settingsUrl({ ok: true }), 302);
});

app.post('/sync', requireManager, async (c) => {
  try {
    const result = await syncEbayOrders(c.env);
    if (result.skipped === 'busy') return c.json({ error: 'an eBay sync is already running — try again in a minute' }, 409);
    if (result.skipped) return c.json({ error: 'eBay is not connected' }, 409);
    return c.json({ ok: true, result });
  } catch (e) {
    const f = ebayFailure(e);
    if (f) return c.json(f.body, f.status);
    throw e;
  }
});

export default app;
