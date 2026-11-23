import { describe, it, expect, vi } from 'vitest';
import { ebayConfig, ebayConfigured } from '../src/ebay/config';
import {
  EBAY_SCOPES, EbayOAuthError, EbayTokenCache, accessTokenProvider, consentUrl, exchangeCode,
  refreshAccessToken,
} from '../src/ebay/oauth';
import { EbayApiError, EbayClient, EbayRateLimitError, type EbayOrder } from '../src/ebay/client';
import { ebayKey, seal, unseal } from '../src/lib/sealed';
import type { Env } from '../src/types';

// The eBay client never reaches eBay here: every call goes through an
// injected fetch that records the request and answers from a script.

const env = {
  EBAY_CLIENT_ID: 'RecycleS-erp-SBX-abc',
  EBAY_CLIENT_SECRET: 'SBX-secret',
  EBAY_RU_NAME: 'Recycle_Servers-RecycleS-erp-SB-xyz',
  JWT_SECRET: 'test-jwt-secret',
} as unknown as Env;
const cfg = ebayConfig(env)!;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });

type Call = { url: URL; method: string; headers: Headers; body: string | undefined };

function fakeFetch(answer: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: new URL(String(input)),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? undefined : String(init.body),
    };
    calls.push(call);
    return answer(call, calls.length);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

describe('ebay config', () => {
  it('needs all three credentials and defaults to the sandbox', () => {
    expect(cfg).toMatchObject({
      environment: 'sandbox',
      apiBase: 'https://api.sandbox.ebay.com',
      authBase: 'https://auth.sandbox.ebay.com',
    });
    expect(ebayConfigured({ ...env, EBAY_RU_NAME: ' ' } as Env)).toBe(false);
    expect(ebayConfig({ ...env, EBAY_ENV: 'production' } as Env)).toMatchObject({
      apiBase: 'https://api.ebay.com', authBase: 'https://auth.ebay.com',
    });
  });

  it('derives a sealing key outside production and refuses without one in it', () => {
    const key = ebayKey(env)!;
    expect(unseal(seal('v^1.1#refresh', key), key)).toBe('v^1.1#refresh');
    expect(ebayKey({ ...env, NODE_ENV: 'production' } as Env)).toBeNull();
    const hex = 'ab'.repeat(32);
    expect(ebayKey({ ...env, NODE_ENV: 'production', EBAY_KEY: hex } as Env)?.toString('hex')).toBe(hex);
  });
});

describe('ebay oauth', () => {
  it('builds the consent URL with the RuName as redirect_uri', () => {
    const u = new URL(consentUrl(cfg, 'nonce-123'));
    expect(`${u.origin}${u.pathname}`).toBe('https://auth.sandbox.ebay.com/oauth2/authorize');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: cfg.clientId,
      redirect_uri: cfg.ruName,
      response_type: 'code',
      scope: EBAY_SCOPES.join(' '),
      state: 'nonce-123',
    });
    expect(EBAY_SCOPES).toEqual(expect.arrayContaining([
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.finances',
    ]));
  });

  it('exchanges a code with Basic auth and a form body', async () => {
    const { fetch, calls } = fakeFetch(() => json({
      access_token: 'v^1.1#at', expires_in: 7200, token_type: 'User Access Token',
      refresh_token: 'v^1.1#rt', refresh_token_expires_in: 47304000,
    }));
    const before = Date.now();
    const tokens = await exchangeCode(cfg, 'v^1.1#i^1#code&with=chars', fetch);

    const [c] = calls;
    expect(c.method).toBe('POST');
    expect(c.url.toString()).toBe('https://api.sandbox.ebay.com/identity/v1/oauth2/token');
    expect(c.headers.get('Authorization')).toBe(
      `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
    );
    expect(c.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(c.body))).toEqual({
      grant_type: 'authorization_code', code: 'v^1.1#i^1#code&with=chars', redirect_uri: cfg.ruName,
    });
    expect(tokens).toMatchObject({
      accessToken: 'v^1.1#at', expiresIn: 7200, refreshToken: 'v^1.1#rt', refreshTokenExpiresIn: 47304000,
    });
    expect(tokens.refreshTokenExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 47304000 * 1000);
  });

  it('refreshes with the scopes and surfaces eBay\'s error', async () => {
    const ok = fakeFetch(() => json({ access_token: 'at2', expires_in: 7200, token_type: 'User Access Token' }));
    const t = await refreshAccessToken(cfg, 'rt', EBAY_SCOPES, ok.fetch);
    expect(t.accessToken).toBe('at2');
    expect(Object.fromEntries(new URLSearchParams(ok.calls[0].body))).toEqual({
      grant_type: 'refresh_token', refresh_token: 'rt', scope: EBAY_SCOPES.join(' '),
    });

    const bad = fakeFetch(() => json({
      error: 'invalid_grant', error_description: 'the provided authorization refresh token is invalid',
    }, 400));
    const err = await refreshAccessToken(cfg, 'rt', EBAY_SCOPES, bad.fetch).catch((e) => e);
    expect(err).toBeInstanceOf(EbayOAuthError);
    expect(err).toMatchObject({ status: 400, error: 'invalid_grant' });
  });

  it('caches the access token per refresh token, with a margin before expiry', async () => {
    let now = 1_000_000;
    const cache = new EbayTokenCache(() => now);
    let minted = 0;
    const mint = vi.fn(async (rt: string) => {
      minted++;
      return { accessToken: `${rt}-at${minted}`, expiresIn: 7200, expiresAt: new Date(now + 7200_000) };
    });

    // Concurrent misses share one mint.
    const [a, b] = await Promise.all([cache.get('rt1', mint), cache.get('rt1', mint)]);
    expect([a, b]).toEqual(['rt1-at1', 'rt1-at1']);
    expect(mint).toHaveBeenCalledTimes(1);

    now += 60 * 60_000;
    expect(await cache.get('rt1', mint)).toBe('rt1-at1');
    // Inside the five-minute margin: mint again.
    now += 56 * 60_000;
    expect(await cache.get('rt1', mint)).toBe('rt1-at2');
    // A reconnect (new refresh token) never reuses the old grant's token.
    expect(await cache.get('rt2', mint)).toBe('rt2-at3');
    expect(await cache.get('rt2', mint, { force: true })).toBe('rt2-at4');
  });
});

const ORDER: EbayOrder = {
  orderId: '12-34567-89012',
  creationDate: '2026-11-20T15:04:05.000Z',
  lastModifiedDate: '2026-11-20T16:00:00.000Z',
  orderFulfillmentStatus: 'NOT_STARTED',
  orderPaymentStatus: 'PAID',
  cancelStatus: { cancelState: 'NONE_REQUESTED' },
  buyer: { username: 'buyer_one' },
  totalMarketplaceFee: { value: '13.25', currency: 'USD' },
  lineItems: [{
    lineItemId: '100', sku: 'RS-EB-1', legacyItemId: '1234567890', quantity: 2,
    lineItemCost: { value: '100.00', currency: 'USD' }, total: { value: '110.00', currency: 'USD' },
  }],
};

describe('ebay client', () => {
  function client(answer: (call: Call, n: number) => Response) {
    const f = fakeFetch(answer);
    const getAccessToken = vi.fn(async (o?: { forceRefresh?: boolean }) =>
      (o?.forceRefresh ? 'fresh-token' : 'cached-token'));
    return { c: new EbayClient({ cfg, getAccessToken, fetch: f.fetch }), getAccessToken, calls: f.calls };
  }

  it('sends the publish flow\'s bodies to the right endpoints', async () => {
    const { c, calls } = client((call) => {
      if (call.method === 'PUT') return new Response(null, { status: 204 });
      if (call.url.pathname.endsWith('/offer')) return json({ offerId: '9001' }, 201);
      return json({ listingId: '1234567890' });
    });

    await c.createOrReplaceInventoryItem('RS-EB-7', {
      availability: { shipToLocationAvailability: { quantity: 4 } },
      condition: 'USED_EXCELLENT',
      product: {
        title: 'Samsung 64GB DDR4-3200 RDIMM M393A8G40AB2-CWE',
        aspects: { Brand: ['Samsung'], 'Capacity per Module': ['64 GB'] },
        imageUrls: ['https://r2.example/a.jpg'],
      },
    });
    const { offerId } = await c.createOffer({
      sku: 'RS-EB-7',
      availableQuantity: 4,
      categoryId: '170083',
      listingPolicies: { fulfillmentPolicyId: 'f1', paymentPolicyId: 'p1', returnPolicyId: 'r1' },
      merchantLocationKey: 'denver',
      pricingSummary: { price: { value: '89.00', currency: 'USD' } },
    });
    const { listingId } = await c.publishOffer(offerId);

    expect(listingId).toBe('1234567890');
    const [put, create, publish] = calls;
    expect(put.method).toBe('PUT');
    expect(put.url.toString()).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item/RS-EB-7');
    expect(put.headers.get('Content-Language')).toBe('en-US');
    expect(put.headers.get('Content-Type')).toBe('application/json');
    expect(put.headers.get('Authorization')).toBe('Bearer cached-token');
    expect(JSON.parse(put.body!)).toMatchObject({
      availability: { shipToLocationAvailability: { quantity: 4 } }, condition: 'USED_EXCELLENT',
    });

    expect(create.method).toBe('POST');
    expect(create.url.pathname).toBe('/sell/inventory/v1/offer');
    expect(create.headers.get('Content-Language')).toBe('en-US');
    expect(JSON.parse(create.body!)).toEqual({
      marketplaceId: 'EBAY_US',
      format: 'FIXED_PRICE',
      sku: 'RS-EB-7',
      availableQuantity: 4,
      categoryId: '170083',
      listingPolicies: { fulfillmentPolicyId: 'f1', paymentPolicyId: 'p1', returnPolicyId: 'r1' },
      merchantLocationKey: 'denver',
      pricingSummary: { price: { value: '89.00', currency: 'USD' } },
    });

    expect(publish.method).toBe('POST');
    expect(publish.url.pathname).toBe('/sell/inventory/v1/offer/9001/publish');
    expect(publish.body).toBeUndefined();
  });

  it('updates and withdraws offers, and reads offers and policies', async () => {
    const { c, calls } = client((call) => {
      const p = call.url.pathname;
      if (p.endsWith('/withdraw')) return json({ listingId: '1234567890' });
      if (call.method === 'PUT') return json({ offerId: '9001' });
      if (p === '/sell/inventory/v1/offer') {
        return call.url.searchParams.get('sku') === 'none'
          ? json({ errors: [{ errorId: 25713, message: 'This Offer is not available.' }] }, 404)
          : json({ total: 1, offers: [{ offerId: '9001', sku: 'RS-EB-7', status: 'PUBLISHED',
            listing: { listingId: '1234567890', listingStatus: 'ACTIVE' } }] });
      }
      if (p.endsWith('/fulfillment_policy')) return json({ fulfillmentPolicies: [{ fulfillmentPolicyId: 'f1', name: 'Free ship' }] });
      if (p.endsWith('/payment_policy')) return json({ paymentPolicies: [{ paymentPolicyId: 'p1', name: 'Pay' }] });
      if (p.endsWith('/return_policy')) return json({ returnPolicies: [{ returnPolicyId: 'r1', name: '30d' }] });
      if (p.endsWith('/location')) return json({ locations: [{ merchantLocationKey: 'denver', name: 'Denver' }] });
      return json({}, 500);
    });

    await c.updateOffer('9001', {
      availableQuantity: 3, categoryId: '170083', merchantLocationKey: 'denver',
      listingPolicies: { fulfillmentPolicyId: 'f1', paymentPolicyId: 'p1', returnPolicyId: 'r1' },
      pricingSummary: { price: { value: '79.00', currency: 'USD' } },
    });
    expect(calls[0].url.pathname).toBe('/sell/inventory/v1/offer/9001');
    expect(calls[0].headers.get('Content-Language')).toBe('en-US');
    expect(JSON.parse(calls[0].body!).pricingSummary.price.value).toBe('79.00');

    expect(await c.withdrawOffer('9001')).toEqual({ listingId: '1234567890' });
    expect((await c.getOffers('RS-EB-7'))[0].listing?.listingId).toBe('1234567890');
    expect(calls.at(-1)!.url.searchParams.get('marketplace_id')).toBe('EBAY_US');
    expect(await c.getOffers('none')).toEqual([]);

    expect((await c.getFulfillmentPolicies())[0].fulfillmentPolicyId).toBe('f1');
    expect((await c.getPaymentPolicies())[0].paymentPolicyId).toBe('p1');
    expect((await c.getReturnPolicies())[0].returnPolicyId).toBe('r1');
    expect(calls.at(-1)!.url.searchParams.get('marketplace_id')).toBe('EBAY_US');
    expect(await c.getInventoryLocations()).toEqual([{ merchantLocationKey: 'denver', name: 'Denver' }]);
  });

  it('retries once on 401 with a forced token refresh', async () => {
    const { c, calls, getAccessToken } = client((call) =>
      (call.headers.get('Authorization') === 'Bearer cached-token'
        ? json({ errors: [{ errorId: 1001, message: 'Invalid access token' }] }, 401)
        : json({ listingId: '42' })));
    expect(await c.publishOffer('1')).toEqual({ listingId: '42' });
    expect(calls.map((x) => x.headers.get('Authorization'))).toEqual(['Bearer cached-token', 'Bearer fresh-token']);
    expect(getAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });

    const always = client(() => json({ errors: [{ errorId: 1001, message: 'Invalid access token' }] }, 401));
    const err = await always.c.publishOffer('1').catch((e) => e);
    expect(err).toBeInstanceOf(EbayApiError);
    expect(err.status).toBe(401);
    expect(always.calls).toHaveLength(2);
  });

  it('carries eBay\'s errors verbatim', async () => {
    const errors = [{
      errorId: 25002, domain: 'API_INVENTORY', category: 'REQUEST',
      message: 'A user error has occurred.',
      longMessage: 'The item condition is not valid for this category.',
      parameters: [{ name: 'text1', value: 'condition' }],
    }];
    const { c } = client(() => json({ errors }, 400));
    const err = await c.publishOffer('1').catch((e) => e);
    expect(err).toBeInstanceOf(EbayApiError);
    expect(err).not.toBeInstanceOf(EbayRateLimitError);
    expect(err.status).toBe(400);
    expect(err.errors).toEqual(errors);
    expect(err.message).toBe('The item condition is not valid for this category.');

    const html = client(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const e2 = await html.c.publishOffer('1').catch((e) => e);
    expect(e2).toMatchObject({ status: 502, errors: [] });
  });

  it('throws a rate-limit error on 429 without retrying', async () => {
    const { c, calls } = client(() =>
      json({ errors: [{ errorId: 2001, message: 'Too many requests.' }] }, 429, { 'Retry-After': '30' }));
    const err = await c.getFulfillmentPolicies().catch((e) => e);
    expect(err).toBeInstanceOf(EbayRateLimitError);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect(calls).toHaveLength(1);
  });

  it('pages through orders with the lastmodifieddate filter', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ ...ORDER, orderId: `o${i}` }));
    const { c, calls } = client((call) => {
      const limit = Number(call.url.searchParams.get('limit'));
      const offset = Number(call.url.searchParams.get('offset'));
      return json({ total: all.length, limit, offset, orders: all.slice(offset, offset + limit) });
    });

    const got: string[] = [];
    for await (const o of c.iterateOrdersSince(new Date('2026-11-01T00:00:00Z'), { pageSize: 2 })) {
      got.push(o.orderId);
    }
    expect(got).toEqual(['o0', 'o1', 'o2', 'o3', 'o4']);
    expect(calls.map((x) => x.url.searchParams.get('offset'))).toEqual(['0', '2', '4']);
    expect(calls[0].url.pathname).toBe('/sell/fulfillment/v1/order');
    expect(calls[0].url.searchParams.get('filter')).toBe('lastmodifieddate:[2026-11-01T00:00:00.000Z..]');
    expect(calls[0].url.search).toContain('filter=lastmodifieddate%3A%5B2026-11-01T00%3A00%3A00.000Z..%5D');
  });

  it('caps a page at 200 and stops on an empty page', async () => {
    const { c, calls } = client(() => json({ total: 10, orders: [] }));
    const page = await c.getOrders({ lastModifiedFrom: '2026-11-01T00:00:00Z', limit: 500 });
    expect(calls[0].url.searchParams.get('limit')).toBe('200');
    expect(page).toMatchObject({ orders: [], total: 10, offset: 0 });
    const got = [];
    for await (const o of c.iterateOrdersSince('2026-11-01T00:00:00Z')) got.push(o);
    expect(got).toEqual([]);
    expect(calls).toHaveLength(2);
  });
});

describe('accessTokenProvider', () => {
  it('mints from the stored refresh token and forces a new one on demand', async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => json({ access_token: `at${++n}`, expires_in: 7200 }));
    const get = accessTokenProvider({
      cfg, getRefreshToken: async () => 'rt', fetch, cache: new EbayTokenCache(),
    });
    expect(await get()).toBe('at1');
    expect(await get()).toBe('at1');
    expect(await get({ forceRefresh: true })).toBe('at2');
    expect(calls).toHaveLength(2);
  });
});
