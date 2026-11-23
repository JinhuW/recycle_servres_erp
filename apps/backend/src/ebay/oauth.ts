// eBay's OAuth authorization-code grant: the seller consents once, the ERP
// keeps the refresh token (valid ~18 months) sealed, and mints 2-hour access
// tokens from it as calls need them.

import { createHash } from 'node:crypto';
import type { EbayConfig } from './config';

export type FetchFn = typeof fetch;

const TIMEOUT_MS = 20_000;
// Access tokens live 7200 s; mint a fresh one this long before expiry so a
// request started near the end doesn't carry a token that dies mid-flight.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const SCOPE_ROOT = 'https://api.ebay.com/oauth/api_scope';

/** What the connection asks the seller for. */
export const EBAY_SCOPES: readonly string[] = [
  SCOPE_ROOT,
  `${SCOPE_ROOT}/sell.inventory`,
  `${SCOPE_ROOT}/sell.fulfillment`,
  `${SCOPE_ROOT}/sell.account`,
  `${SCOPE_ROOT}/sell.finances`,
];

/** An access token with its lifetime. */
export interface EbayAccessToken {
  accessToken: string;
  /** Seconds, as eBay reported it. */
  expiresIn: number;
  expiresAt: Date;
}

/** What a code exchange returns: an access token plus the long-lived refresh token. */
export interface EbayUserTokens extends EbayAccessToken {
  refreshToken: string;
  /** Seconds, as eBay reported it. */
  refreshTokenExpiresIn: number;
  refreshTokenExpiresAt: Date;
}

/** eBay refused a token request; `error` is its code (e.g. invalid_grant). */
export class EbayOAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly errorDescription: string,
  ) {
    super(`eBay OAuth ${status}: ${error}${errorDescription ? ` (${errorDescription})` : ''}`);
    this.name = 'EbayOAuthError';
  }
}

/** The URL the seller is sent to; eBay returns to the RuName's accept URL with `code` and `state`. */
export function consentUrl(
  cfg: EbayConfig,
  state: string,
  scopes: readonly string[] = EBAY_SCOPES,
): string {
  const qs = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.ruName,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
  });
  return `${cfg.authBase}/oauth2/authorize?${qs.toString()}`;
}

type WireToken = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
};

async function tokenRequest(
  cfg: EbayConfig,
  form: Record<string, string>,
  fetchFn: FetchFn,
): Promise<WireToken & { access_token: string; expires_in: number }> {
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const res = await fetchFn(`${cfg.apiBase}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as WireToken | null;
  if (!res.ok || !body?.access_token || typeof body.expires_in !== 'number') {
    throw new EbayOAuthError(
      res.status,
      body?.error ?? 'invalid_response',
      body?.error_description ?? '',
    );
  }
  return body as WireToken & { access_token: string; expires_in: number };
}

const after = (seconds: number, now: number) => new Date(now + seconds * 1000);

/** Trades the consent callback's `code` for the seller's tokens. */
export async function exchangeCode(
  cfg: EbayConfig,
  code: string,
  fetchFn: FetchFn = fetch,
): Promise<EbayUserTokens> {
  const now = Date.now();
  const body = await tokenRequest(
    cfg,
    { grant_type: 'authorization_code', code, redirect_uri: cfg.ruName },
    fetchFn,
  );
  if (!body.refresh_token || typeof body.refresh_token_expires_in !== 'number') {
    throw new EbayOAuthError(200, 'invalid_response', 'no refresh token in the code exchange');
  }
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    expiresAt: after(body.expires_in, now),
    refreshToken: body.refresh_token,
    refreshTokenExpiresIn: body.refresh_token_expires_in,
    refreshTokenExpiresAt: after(body.refresh_token_expires_in, now),
  };
}

/** Mints an access token from the stored refresh token. The scopes must be a subset of the consented ones. */
export async function refreshAccessToken(
  cfg: EbayConfig,
  refreshToken: string,
  scopes: readonly string[] = EBAY_SCOPES,
  fetchFn: FetchFn = fetch,
): Promise<EbayAccessToken> {
  const now = Date.now();
  const body = await tokenRequest(
    cfg,
    { grant_type: 'refresh_token', refresh_token: refreshToken, scope: scopes.join(' ') },
    fetchFn,
  );
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    expiresAt: after(body.expires_in, now),
  };
}

/**
 * In-memory access tokens, keyed by a hash of the refresh token they came
 * from: a reconnect stores a new refresh token, and the next call then mints
 * rather than reusing a token from the old grant. Concurrent misses share one
 * mint.
 */
export class EbayTokenCache {
  private entry: { key: string; token: EbayAccessToken } | null = null;
  private inFlight: { key: string; promise: Promise<EbayAccessToken> } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  async get(
    refreshToken: string,
    mint: (refreshToken: string) => Promise<EbayAccessToken>,
    opts: { force?: boolean } = {},
  ): Promise<string> {
    const key = createHash('sha256').update(refreshToken).digest('hex');
    const hit = this.entry;
    if (
      !opts.force &&
      hit?.key === key &&
      hit.token.expiresAt.getTime() - EXPIRY_MARGIN_MS > this.now()
    ) {
      return hit.token.accessToken;
    }
    if (this.inFlight?.key !== key) {
      const promise = mint(refreshToken).then(
        (token) => {
          this.entry = { key, token };
          return token;
        },
      ).finally(() => {
        if (this.inFlight?.promise === promise) this.inFlight = null;
      });
      this.inFlight = { key, promise };
    }
    return (await this.inFlight.promise).accessToken;
  }

  clear(): void {
    this.entry = null;
  }
}

const defaultCache = new EbayTokenCache();

/**
 * The `getAccessToken` an EbayClient takes: reads the current refresh token
 * (from the sealed connection row) on every call, and mints through the cache.
 */
export function accessTokenProvider(opts: {
  cfg: EbayConfig;
  getRefreshToken: () => Promise<string>;
  fetch?: FetchFn;
  cache?: EbayTokenCache;
  scopes?: readonly string[];
}): (o?: { forceRefresh?: boolean }) => Promise<string> {
  const cache = opts.cache ?? defaultCache;
  const fetchFn = opts.fetch ?? fetch;
  return async (o = {}) =>
    cache.get(
      await opts.getRefreshToken(),
      (rt) => refreshAccessToken(opts.cfg, rt, opts.scopes ?? EBAY_SCOPES, fetchFn),
      { force: o.forceRefresh },
    );
}
