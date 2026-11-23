// The connected eBay seller account: reading its row, opening a client on its
// sealed refresh token, picking the account defaults a listing is published
// with, and turning eBay's refusals into the desk's HTTP answers.

import type { SqlLike } from '../db';
import { ebayKey, unseal } from '../lib/sealed';
import type { Env } from '../types';
import { EbayApiError, EbayClient } from './client';
import { ebayConfig, ebayEnvironment, type EbayConfig } from './config';
import { accessTokenProvider, EbayOAuthError, EbayTokenCache, type FetchFn } from './oauth';

/** Access tokens minted for the connection. A reconnect or disconnect clears it. */
export const ebayTokenCache = new EbayTokenCache();

// Calls to eBay that run inside a transaction: give it longer than the pool's
// 60 s idle-in-transaction limit, which a slow eBay plus a token mint can pass.
export async function allowSlowEbayTx(tx: SqlLike): Promise<void> {
  await tx`SET LOCAL idle_in_transaction_session_timeout = '3min'`;
}

export type ConnectionRow = {
  environment: 'sandbox' | 'production';
  refresh_token_sealed: string;
  refresh_token_expires_at: Date;
  ebay_user_id: string | null;
  ebay_username: string | null;
  marketplace_id: string;
  merchant_location_key: string | null;
  fulfillment_policy_id: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  setup_issues: SetupIssue[];
  sync_cursor: Date | null;
  last_sync_at: Date | null;
  last_error: string | null;
  last_result: Record<string, unknown> | null;
  connected_by: string | null;
  connected_at: Date;
};

export type DefaultsField =
  | 'merchantLocationKey' | 'fulfillmentPolicyId' | 'paymentPolicyId' | 'returnPolicyId';

/** Why a default is missing: the account has none, several with none marked default, or eBay refused the read. */
export type SetupIssue = { field: DefaultsField; reason: 'none' | 'ambiguous' | 'error'; message?: string };

export type AccountDefaults = {
  merchantLocationKey: string | null;
  fulfillmentPolicyId: string | null;
  paymentPolicyId: string | null;
  returnPolicyId: string | null;
  issues: SetupIssue[];
};

/** The row, or null when there is none for the environment the keys are for. */
export async function loadConnection(sql: SqlLike, env: Env): Promise<ConnectionRow | null> {
  const [row] = await sql<ConnectionRow[]>`SELECT * FROM ebay_connection WHERE id = 1`;
  if (!row || row.environment !== ebayEnvironment(env)) return null;
  return row;
}

export type EbayContext = { client: EbayClient; conn: ConnectionRow; cfg: EbayConfig };
export type EbayUnavailable = { status: 409 | 503; error: string };

/**
 * A client for the connected account, or why there is none. `fetch` is for
 * tests; it defaults to the global one at call time.
 */
export async function openEbay(
  env: Env, sql: SqlLike, fetchFn?: FetchFn,
): Promise<EbayContext | EbayUnavailable> {
  const cfg = ebayConfig(env);
  if (!cfg) return { status: 503, error: 'eBay is not configured on this server (EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_RU_NAME)' };
  const key = ebayKey(env);
  if (!key) return { status: 503, error: 'EBAY_KEY is not set on this server' };
  const conn = await loadConnection(sql, env);
  if (!conn) return { status: 409, error: 'eBay is not connected — a manager connects it in Settings ▸ eBay' };
  const refreshToken = unseal(conn.refresh_token_sealed, key);
  const fetcher = fetchFn ?? ((...a: Parameters<FetchFn>) => fetch(...a));
  const client = new EbayClient({
    cfg,
    fetch: fetcher,
    marketplaceId: conn.marketplace_id,
    getAccessToken: accessTokenProvider({
      cfg, fetch: fetcher, cache: ebayTokenCache, getRefreshToken: async () => refreshToken,
    }),
  });
  return { client, conn, cfg };
}

export const isUnavailable = (x: EbayContext | EbayUnavailable): x is EbayUnavailable => 'status' in x;

/** A desk action that has to reach eBay and can't: not configured, not connected, or missing a default. */
export class EbayNotReady extends Error {
  constructor(readonly status: 409 | 503, message: string) {
    super(message);
    this.name = 'EbayNotReady';
  }
}

/** openEbay, throwing when there is no client. For use inside a transaction that should roll back. */
export async function requireEbay(env: Env, sql: SqlLike, fetchFn?: FetchFn): Promise<EbayContext> {
  const ctx = await openEbay(env, sql, fetchFn);
  if (isUnavailable(ctx)) throw new EbayNotReady(ctx.status, ctx.error);
  return ctx;
}

type Policy = { id: string; categoryTypes?: { name: string; default?: boolean }[] };

// The default for ordinary (non-vehicle) listings wins over a motors default.
function pickPolicy(policies: Policy[]): { id: string } | { reason: 'none' | 'ambiguous' } {
  if (policies.length === 0) return { reason: 'none' };
  const defaults = policies.filter((p) => p.categoryTypes?.some((ct) => ct.default));
  const general = defaults.filter((p) =>
    p.categoryTypes?.some((ct) => ct.default && ct.name === 'ALL_EXCLUDING_MOTORS_VEHICLES'));
  if (general.length === 1) return { id: general[0].id };
  if (defaults.length === 1) return { id: defaults[0].id };
  if (policies.length === 1) return { id: policies[0].id };
  return { reason: 'ambiguous' };
}

/**
 * What a new listing is published with, read from the account: the first
 * enabled inventory location, and per policy type the account's default, else
 * its only policy. The owner chose not to have pickers, so anything that
 * can't be decided this way is left null and reported.
 */
export async function pickAccountDefaults(client: EbayClient): Promise<AccountDefaults> {
  const issues: SetupIssue[] = [];
  const settle = async <T>(field: DefaultsField, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (e) {
      const f = ebayFailure(e);
      if (!f) throw e;
      issues.push({ field, reason: 'error', message: f.body.error });
      return null;
    }
  };
  const [locations, fulfillment, payment, returns] = await Promise.all([
    settle('merchantLocationKey', () => client.getInventoryLocations()),
    settle('fulfillmentPolicyId', () => client.getFulfillmentPolicies()),
    settle('paymentPolicyId', () => client.getPaymentPolicies()),
    settle('returnPolicyId', () => client.getReturnPolicies()),
  ]);

  let merchantLocationKey: string | null = null;
  if (locations) {
    const enabled = locations.find((l) => (l.merchantLocationStatus ?? 'ENABLED') === 'ENABLED');
    if (enabled) merchantLocationKey = enabled.merchantLocationKey;
    else issues.push({ field: 'merchantLocationKey', reason: 'none' });
  }
  const policy = (field: DefaultsField, list: Policy[] | null): string | null => {
    if (!list) return null;
    const picked = pickPolicy(list);
    if ('id' in picked) return picked.id;
    issues.push({ field, reason: picked.reason });
    return null;
  };
  return {
    merchantLocationKey,
    fulfillmentPolicyId: policy('fulfillmentPolicyId',
      fulfillment?.map((p) => ({ id: p.fulfillmentPolicyId, categoryTypes: p.categoryTypes })) ?? null),
    paymentPolicyId: policy('paymentPolicyId',
      payment?.map((p) => ({ id: p.paymentPolicyId, categoryTypes: p.categoryTypes })) ?? null),
    returnPolicyId: policy('returnPolicyId',
      returns?.map((p) => ({ id: p.returnPolicyId, categoryTypes: p.categoryTypes })) ?? null),
    issues,
  };
}

export async function saveAccountDefaults(sql: SqlLike, d: AccountDefaults): Promise<void> {
  await sql`
    UPDATE ebay_connection
       SET merchant_location_key = ${d.merchantLocationKey}, fulfillment_policy_id = ${d.fulfillmentPolicyId},
           payment_policy_id = ${d.paymentPolicyId}, return_policy_id = ${d.returnPolicyId},
           setup_issues = ${sql.json(d.issues as never)}, updated_at = NOW()
     WHERE id = 1
  `;
}

export const missingDefaults = (c: Pick<ConnectionRow,
  'merchant_location_key' | 'fulfillment_policy_id' | 'payment_policy_id' | 'return_policy_id'>): DefaultsField[] => [
  ...(c.merchant_location_key ? [] : ['merchantLocationKey' as const]),
  ...(c.fulfillment_policy_id ? [] : ['fulfillmentPolicyId' as const]),
  ...(c.payment_policy_id ? [] : ['paymentPolicyId' as const]),
  ...(c.return_policy_id ? [] : ['returnPolicyId' as const]),
];

/**
 * An eBay refusal as the desk answers it: eBay's own errors verbatim, 422
 * when eBay rejected the request (fix the listing), 502 when eBay failed or
 * throttled (try again). A refused refresh token means reconnecting. Null
 * for anything else, which the caller rethrows.
 */
export function ebayFailure(
  e: unknown,
): { status: 409 | 422 | 502 | 503; body: { error: string; ebay: unknown[] } } | null {
  if (e instanceof EbayNotReady) return { status: e.status, body: { error: e.message, ebay: [] } };
  if (e instanceof EbayApiError) {
    const status = e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 401 ? 422 : 502;
    return { status, body: { error: `eBay: ${e.message}`, ebay: e.errors } };
  }
  if (e instanceof EbayOAuthError) {
    return {
      status: 502,
      body: {
        error: e.error === 'invalid_grant'
          ? 'eBay refused the stored sign-in — a manager has to reconnect eBay in Settings'
          : `eBay sign-in failed: ${e.message}`,
        ebay: [{ error: e.error, error_description: e.errorDescription }],
      },
    };
  }
  // undici's network failure is a TypeError('fetch failed'); other TypeErrors are bugs.
  if (e instanceof Error && (e.name === 'TimeoutError' || (e instanceof TypeError && e.message === 'fetch failed'))) {
    return { status: 502, body: { error: `eBay could not be reached: ${e.message}`, ebay: [] } };
  }
  return null;
}
