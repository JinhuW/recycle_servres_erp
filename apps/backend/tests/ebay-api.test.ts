import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { api, testEnv } from './helpers/app';
import { loginAs, ALEX, SOFIA, MARCUS, EBAY } from './helpers/auth';
import { freeSellableLine } from './helpers/inventory';
import { ebayTokenCache } from '../src/ebay/connection';
import { EBAY_SYNC_LOCK, syncEbayOrders } from '../src/ebay/sync';
import { ebayKey, seal, unseal } from '../src/lib/sealed';
import type { Env } from '../src/types';

// The ERP side of the eBay API: Settings ▸ eBay's OAuth round trip, publish,
// the price/end hooks and the order sync. eBay is never reached: global fetch
// is stubbed with a script that answers by method and path, and records every
// call so the tests can read what the ERP sent.

const EBAY_ENV = {
  EBAY_CLIENT_ID: 'RecycleS-erp-SBX-abc',
  EBAY_CLIENT_SECRET: 'SBX-secret', // pragma: allowlist secret
  EBAY_RU_NAME: 'Recycle_Servers-RecycleS-erp-SB-xyz',
  EBAY_ENV: 'sandbox',
};
const env = { ...testEnv, ...EBAY_ENV } as Env;

const REFRESH = 'v^1.1#i^1#REFRESH-SECRET-abc';
const ACCESS = 'v^1.1#i^1#ACCESS-SECRET-xyz';

type Call = { method: string; host: string; path: string; query: URLSearchParams; body: unknown };
type Handler = (call: Call) => Response | undefined;

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
const noContent = () => new Response(null, { status: 204 });
const ebayError = (status: number, errorId: number, message: string) =>
  json({ errors: [{ errorId, domain: 'API_INVENTORY', category: 'REQUEST', message, longMessage: message }] }, status);

let calls: Call[] = [];
let handlers: Handler[] = [];

// Answers the token endpoint by default; each test adds handlers in front.
function onEbay(h: Handler) { handlers.unshift(h); }
const called = (method: string, path: string | RegExp) =>
  calls.filter(c => c.method === method && (typeof path === 'string' ? c.path === path : path.test(c.path)));

beforeEach(() => {
  calls = [];
  handlers = [(c) => (c.path === '/identity/v1/oauth2/token'
    ? json({ access_token: ACCESS, expires_in: 7200, token_type: 'User Access Token' })
    : undefined)];
  ebayTokenCache.clear();
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const raw = init?.body === undefined || init.body === null ? undefined : String(init.body);
    let body: unknown = raw;
    try { body = raw === undefined ? undefined : JSON.parse(raw); } catch { /* form body */ }
    const call = { method: init?.method ?? 'GET', host: url.host, path: url.pathname, query: url.searchParams, body };
    calls.push(call);
    for (const h of handlers) {
      const r = h(call);
      if (r) return r;
    }
    throw new Error(`unexpected eBay call ${call.method} ${url}`);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function connect(over: Record<string, unknown> = {}) {
  const db = getTestDb();
  const row = {
    id: 1, environment: 'sandbox', refresh_token_sealed: seal(REFRESH, ebayKey(env)!),
    refresh_token_expires_at: new Date(Date.now() + 500 * 86_400_000), ebay_username: 'rs-seller',
    merchant_location_key: 'denver', fulfillment_policy_id: 'fp-1', payment_policy_id: 'pp-1',
    return_policy_id: 'rp-1', ...over,
  };
  await db`INSERT INTO ebay_connection ${db(row)}`;
}

// Lots already used by this test, so a second listing comes from another lot.
const usedLines = new Set<string>();
beforeEach(() => { usedLines.clear(); });

/** A Queued listing on a RAM lot with one uploaded photo. */
async function queuedListing(token: string, qty = 2, price = 45): Promise<{ id: string; lineId: string }> {
  const db = getTestDb();
  const line = await freeSellableLine(token, qty, usedLines);
  usedLines.add(line.id);
  await db`
    UPDATE order_lines SET category = 'RAM', brand = 'Samsung', capacity = '32GB', generation = 'DDR4',
           speed = '2666', classification = 'RDIMM', part_number = 'M393A4K40CB2-CTD', condition = 'Used'
    WHERE id = ${line.id}
  `;
  const [{ order_id }] = await db<{ order_id: string }[]>`SELECT order_id FROM order_lines WHERE id = ${line.id}`;
  await db`
    INSERT INTO order_line_photos (order_line_id, order_id, filename, size_bytes, mime_type, storage_key, delivery_url)
    VALUES (${line.id}, ${order_id}, 'a.jpg', 1000, 'image/jpeg', 'k/a.jpg', 'https://static.example.com/k/a.jpg')
  `;
  const r = await api<{ ids: string[] }>('POST', '/api/ebay/listings', {
    token, body: { inventoryId: line.id, listings: [{ qty, listPrice: price, title: 'Samsung 32GB DDR4 RDIMM' }] },
  });
  expect(r.status).toBe(201);
  return { id: r.body.ids[0], lineId: line.id };
}

/** A listing already published as offer off-9 (item 110555000999); `n` varies both for a second one. */
async function listedListing(token: string, qty = 3, n = 9) {
  const l = await queuedListing(token, qty);
  const itemId = `11055500099${n}`;
  await getTestDb()`
    UPDATE ebay_listings SET status = 'Listed', listed_at = NOW(), ebay_offer_id = ${`off-${n}`},
           ebay_item_id = ${itemId}, ebay_url = ${`https://sandbox.ebay.com/itm/${itemId}`}
    WHERE id = ${l.id}
  `;
  return l;
}

const listing = async (id: string) => (await getTestDb()<{
  status: string; ebay_offer_id: string | null; ebay_item_id: string | null; ebay_url: string | null;
  list_price: string;
}[]>`SELECT status, ebay_offer_id, ebay_item_id, ebay_url, list_price FROM ebay_listings WHERE id = ${id}`)[0];

describe('eBay connection: OAuth', () => {
  beforeEach(async () => { await resetDb(); });

  async function start(token: string) {
    const r = await api('GET', '/api/ebay/oauth/start', { token, env: EBAY_ENV });
    expect(r.status).toBe(302);
    const to = new URL(r.headers.get('location')!);
    expect(to.origin).toBe('https://auth.sandbox.ebay.com');
    expect(to.searchParams.get('redirect_uri')).toBe(EBAY_ENV.EBAY_RU_NAME);
    expect(to.searchParams.get('scope')).toContain('sell.inventory');
    return to.searchParams.get('state')!;
  }
  const callback = (token: string | undefined, q: Record<string, string>) =>
    api('GET', `/api/ebay/oauth/callback?${new URLSearchParams(q)}`, { token, env: EBAY_ENV });
  const outcome = (r: { headers: Headers }) => r.headers.get('location');

  function accountAnswers() {
    onEbay((c) => {
      if (c.path === '/identity/v1/oauth2/token') {
        return json({
          access_token: ACCESS, expires_in: 7200, refresh_token: REFRESH,
          refresh_token_expires_in: 47_304_000, token_type: 'User Access Token',
        });
      }
      if (c.host === 'apiz.sandbox.ebay.com' && c.path === '/commerce/identity/v1/user/') {
        return json({ userId: 'u-77', username: 'rs-seller' });
      }
      if (c.path === '/sell/inventory/v1/location') {
        return json({ locations: [
          { merchantLocationKey: 'old', merchantLocationStatus: 'DISABLED' },
          { merchantLocationKey: 'denver', merchantLocationStatus: 'ENABLED' },
        ] });
      }
      if (c.path === '/sell/account/v1/fulfillment_policy') {
        return json({ fulfillmentPolicies: [
          { fulfillmentPolicyId: 'fp-a', name: 'A', categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES' }] },
          { fulfillmentPolicyId: 'fp-b', name: 'B', categoryTypes: [{ name: 'ALL_EXCLUDING_MOTORS_VEHICLES', default: true }] },
        ] });
      }
      if (c.path === '/sell/account/v1/payment_policy') {
        return json({ paymentPolicies: [{ paymentPolicyId: 'pp-only', name: 'Only' }] });
      }
      if (c.path === '/sell/account/v1/return_policy') {
        return json({ returnPolicies: [
          { returnPolicyId: 'rp-a', name: '30 days' }, { returnPolicyId: 'rp-b', name: 'None' },
        ] });
      }
      return undefined;
    });
  }

  it('connects: state checked, token sealed, defaults picked, and no response carries a token', async () => {
    const { token } = await loginAs(ALEX);
    accountAnswers();
    const state = await start(token);
    const r = await callback(token, { code: 'v^1.1#code', state });
    expect(outcome(r)).toBe('/#/settings?section=ebay&ebay=connected');

    const exchange = called('POST', '/identity/v1/oauth2/token')[0];
    expect(String(exchange.body)).toContain('grant_type=authorization_code');
    expect(String(exchange.body)).toContain(`redirect_uri=${EBAY_ENV.EBAY_RU_NAME}`);

    const [row] = await getTestDb()<{ refresh_token_sealed: string; fulfillment_policy_id: string; payment_policy_id: string;
      return_policy_id: string | null; merchant_location_key: string; ebay_username: string; setup_issues: unknown }[]>`
      SELECT * FROM ebay_connection`;
    expect(row.refresh_token_sealed).not.toContain('REFRESH-SECRET');
    expect(unseal(row.refresh_token_sealed, ebayKey(env)!)).toBe(REFRESH);
    expect(row).toMatchObject({
      merchant_location_key: 'denver', fulfillment_policy_id: 'fp-b', payment_policy_id: 'pp-only',
      return_policy_id: null, ebay_username: 'rs-seller',
    });
    expect(row.setup_issues).toEqual([{ field: 'returnPolicyId', reason: 'ambiguous' }]);

    const status = await api<Record<string, unknown>>('GET', '/api/ebay/connection', { token, env: EBAY_ENV });
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      configured: true, connected: true, environment: 'sandbox', account: { userId: 'u-77', username: 'rs-seller' },
      missingDefaults: ['returnPolicyId'], reconnectSoon: false,
    });
    const text = JSON.stringify(status.body);
    for (const secret of [REFRESH, ACCESS, 'REFRESH-SECRET', 'ACCESS-SECRET', row.refresh_token_sealed]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('refresh_token_sealed');
  });

  it('refuses a callback whose state is unknown, reused, expired, another user’s, or without a session', async () => {
    const { token } = await loginAs(ALEX);
    const { token: sofia } = await loginAs(SOFIA);
    accountAnswers();

    expect(outcome(await callback(token, { code: 'c', state: 'made-up' }))).toContain('reason=state');

    const s1 = await start(token);
    expect(outcome(await callback(sofia, { code: 'c', state: s1 }))).toContain('reason=state');
    // The other user's attempt spent it.
    expect(outcome(await callback(token, { code: 'c', state: s1 }))).toContain('reason=state');

    const s2 = await start(token);
    await getTestDb()`UPDATE ebay_oauth_states SET expires_at = NOW() - INTERVAL '1 minute'`;
    expect(outcome(await callback(token, { code: 'c', state: s2 }))).toContain('reason=state');

    const s3 = await start(token);
    expect(outcome(await callback(undefined, { code: 'c', state: s3 }))).toContain('reason=session');

    const s4 = await start(token);
    expect(outcome(await callback(token, { state: s4 }))).toContain('reason=declined');

    expect(called('POST', '/identity/v1/oauth2/token')).toHaveLength(0);
    expect((await getTestDb()`SELECT 1 FROM ebay_connection`).length).toBe(0);

    const s5 = await start(token);
    expect(outcome(await callback(token, { code: 'c', state: s5 }))).toContain('ebay=connected');
    expect(outcome(await callback(token, { code: 'c', state: s5 }))).toContain('reason=state');
  });

  it('is manager-only; disconnect forgets the account', async () => {
    const { token: purchaser } = await loginAs(MARCUS);
    const { token: operator } = await loginAs(EBAY);
    for (const t of [purchaser, operator]) {
      expect((await api('GET', '/api/ebay/connection', { token: t, env: EBAY_ENV })).status).toBe(403);
      expect((await api('GET', '/api/ebay/oauth/start', { token: t, env: EBAY_ENV })).status).toBe(403);
      expect((await api('DELETE', '/api/ebay/connection', { token: t, env: EBAY_ENV })).status).toBe(403);
      expect((await api('POST', '/api/ebay/sync', { token: t, env: EBAY_ENV })).status).toBe(403);
    }
    const { token } = await loginAs(ALEX);
    await connect();
    expect((await api('DELETE', '/api/ebay/connection', { token, env: EBAY_ENV })).status).toBe(200);
    const after = await api<{ connected: boolean }>('GET', '/api/ebay/connection', { token, env: EBAY_ENV });
    expect(after.body.connected).toBe(false);
  });

  it('start goes back to Settings when the server has no eBay keys', async () => {
    const { token } = await loginAs(ALEX);
    const r = await api('GET', '/api/ebay/oauth/start', { token });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/#/settings?section=ebay&ebay=error&reason=not_configured');
  });
});

describe('eBay publish and the listing hooks', () => {
  beforeEach(async () => { await resetDb(); await connect(); });

  function publishAnswers(opts: { offers?: unknown[]; publish?: () => Response } = {}) {
    onEbay((c) => {
      if (c.method === 'PUT' && c.path.startsWith('/sell/inventory/v1/inventory_item/')) return noContent();
      if (c.method === 'GET' && c.path === '/sell/inventory/v1/offer') {
        return opts.offers ? json({ offers: opts.offers }) : ebayError(404, 25713, 'This Offer is not available.');
      }
      if (c.method === 'POST' && c.path === '/sell/inventory/v1/offer') return json({ offerId: 'off-1' }, 201);
      if (c.method === 'PUT' && /^\/sell\/inventory\/v1\/offer\/[^/]+$/.test(c.path)) return noContent();
      if (c.method === 'POST' && /\/offer\/[^/]+\/publish$/.test(c.path)) {
        return opts.publish ? opts.publish() : json({ listingId: '110555000111' });
      }
      return undefined;
    });
  }

  it('publishes a Queued listing and marks it Listed with the offer and item', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await queuedListing(token, 2, 45);
    publishAnswers();
    const r = await api<Record<string, unknown>>('POST', `/api/ebay/listings/${id}/publish`, { token, env: EBAY_ENV });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'Listed', offerId: 'off-1', itemId: '110555000111', url: 'https://sandbox.ebay.com/itm/110555000111',
    });
    expect(await listing(id)).toMatchObject({
      status: 'Listed', ebay_offer_id: 'off-1', ebay_item_id: '110555000111',
    });

    const sku = `RS-${id}`;
    const item = called('PUT', `/sell/inventory/v1/inventory_item/${sku}`)[0].body as Record<string, any>;
    expect(item.condition).toBe('USED_EXCELLENT');
    expect(item.availability.shipToLocationAvailability.quantity).toBe(2);
    expect(item.product).toMatchObject({
      title: 'Samsung 32GB DDR4 RDIMM', imageUrls: ['https://static.example.com/k/a.jpg'], mpn: 'M393A4K40CB2-CTD',
    });
    expect(item.product.aspects.Brand).toEqual(['Samsung']);
    const offer = called('POST', '/sell/inventory/v1/offer')[0].body as Record<string, any>;
    expect(offer).toMatchObject({
      sku, marketplaceId: 'EBAY_US', format: 'FIXED_PRICE', availableQuantity: 2, categoryId: '170083',
      merchantLocationKey: 'denver', pricingSummary: { price: { value: '45.00', currency: 'USD' } },
      listingPolicies: { fulfillmentPolicyId: 'fp-1', paymentPolicyId: 'pp-1', returnPolicyId: 'rp-1' },
    });
    const [ev] = await getTestDb()<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM ebay_listing_events WHERE listing_id = ${id} AND kind = 'listed'`;
    expect(ev.detail).toMatchObject({ offerId: 'off-1', itemId: '110555000111', via: 'api' });

    const again = await api('POST', `/api/ebay/listings/${id}/publish`, { token, env: EBAY_ENV });
    expect(again.status).toBe(409);
  });

  it('a publish eBay fails halfway leaves the listing Queued, and the retry reuses the offer', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await queuedListing(token);
    publishAnswers({ publish: () => ebayError(500, 25001, 'A system error has occurred.') });
    const first = await api<{ error: string; ebay: { errorId: number; message: string }[] }>(
      'POST', `/api/ebay/listings/${id}/publish`, { token, env: EBAY_ENV });
    expect(first.status).toBe(502);
    expect(first.body.ebay).toEqual([expect.objectContaining({ errorId: 25001, message: 'A system error has occurred.' })]);
    expect(first.body.error).toContain('A system error has occurred.');
    expect(await listing(id)).toMatchObject({ status: 'Queued', ebay_offer_id: null });

    calls = [];
    handlers = handlers.slice(-1);
    publishAnswers({ offers: [{ offerId: 'off-1', sku: `RS-${id}`, status: 'UNPUBLISHED' }] });
    const retry = await api('POST', `/api/ebay/listings/${id}/publish`, { token, env: EBAY_ENV });
    expect(retry.status).toBe(200);
    expect(called('POST', '/sell/inventory/v1/offer')).toHaveLength(0);
    expect(called('PUT', '/sell/inventory/v1/offer/off-1')).toHaveLength(1);
    expect(called('POST', '/sell/inventory/v1/offer/off-1/publish')).toHaveLength(1);
    expect(await listing(id)).toMatchObject({ status: 'Listed', ebay_offer_id: 'off-1' });
  });

  it('an offer eBay already published is only recorded', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await queuedListing(token);
    publishAnswers({
      offers: [{ offerId: 'off-1', status: 'PUBLISHED', listing: { listingId: '110555000222', listingStatus: 'ACTIVE' } }],
    });
    const r = await api('POST', `/api/ebay/listings/${id}/publish`, { token, env: EBAY_ENV });
    expect(r.status).toBe(200);
    expect(called('POST', /\/publish$/)).toHaveLength(0);
    expect(await listing(id)).toMatchObject({ status: 'Listed', ebay_item_id: '110555000222' });
  });

  it('a request eBay rejects is a 422 with eBay’s errors; the eBay role may publish, a purchaser may not', async () => {
    const { token } = await loginAs(ALEX);
    const { token: operator } = await loginAs(EBAY);
    const { token: purchaser } = await loginAs(MARCUS);
    const { id } = await queuedListing(token);
    publishAnswers();
    onEbay((c) => (c.method === 'POST' && c.path === '/sell/inventory/v1/offer'
      ? ebayError(400, 25709, 'Invalid value for categoryId.') : undefined));
    const bad = await api<{ ebay: { errorId: number }[] }>('POST', `/api/ebay/listings/${id}/publish`, { token: operator, env: EBAY_ENV });
    expect(bad.status).toBe(422);
    expect(bad.body.ebay[0].errorId).toBe(25709);

    expect((await api('POST', `/api/ebay/listings/${id}/publish`, { token: purchaser, env: EBAY_ENV })).status).toBe(403);

    handlers = handlers.slice(1);
    const ok = await api('POST', `/api/ebay/listings/${id}/publish`, { token: operator, env: EBAY_ENV });
    expect(ok.status).toBe(200);
  });

  it('refuses to publish without a connection or a default policy', async () => {
    const { token } = await loginAs(ALEX);
    const { id } = await queuedListing(token);
    await getTestDb()`UPDATE ebay_connection SET return_policy_id = NULL`;
    onEbay((c) => {
      if (c.path === '/sell/inventory/v1/location') return json({ locations: [{ merchantLocationKey: 'denver' }] });
      if (c.path === '/sell/account/v1/fulfillment_policy') return json({ fulfillmentPolicies: [{ fulfillmentPolicyId: 'fp-1' }] });
      if (c.path === '/sell/account/v1/payment_policy') return json({ paymentPolicies: [{ paymentPolicyId: 'pp-1' }] });
      if (c.path === '/sell/account/v1/return_policy') return json({ returnPolicies: [] });
      return undefined;
    });
    const r = await api<{ error: string }>('POST', `/api/ebay/listings/${id}/publish`, { token, env: EBAY_ENV });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('returnPolicyId');

    await getTestDb()`DELETE FROM ebay_connection`;
    const none = await api<{ error: string }>('POST', `/api/ebay/listings/${id}/publish`, { token, env: EBAY_ENV });
    expect(none.status).toBe(409);
    expect(none.body.error).toMatch(/not connected/);
  });

  it('ending a published listing withdraws it on eBay first; if eBay refuses and it is live, so does the ERP', async () => {
    const { token } = await loginAs(ALEX);
    const a = await listedListing(token);
    let withdrawAnswer = () => ebayError(400, 25002, 'The listing cannot be ended.');
    let offerState = { status: 'PUBLISHED', listing: { listingId: '110555000999', listingStatus: 'ACTIVE' } };
    onEbay((c) => {
      if (c.method === 'POST' && c.path === '/sell/inventory/v1/offer/off-9/withdraw') return withdrawAnswer();
      if (c.method === 'GET' && c.path === '/sell/inventory/v1/offer') return json({ offers: [{ offerId: 'off-9', ...offerState }] });
      return undefined;
    });

    const refused = await api<{ ebay: unknown[] }>('POST', `/api/ebay/listings/${a.id}/end`, {
      token, env: EBAY_ENV, body: { reason: 'no_buyer' } });
    expect(refused.status).toBe(422);
    expect(refused.body.ebay).toHaveLength(1);
    expect((await listing(a.id)).status).toBe('Listed');

    // Already down on eBay: the refusal is moot and the ERP ends it.
    offerState = { status: 'PUBLISHED', listing: { listingId: '110555000999', listingStatus: 'ENDED' } };
    const moot = await api('POST', `/api/ebay/listings/${a.id}/end`, { token, env: EBAY_ENV, body: { reason: 'no_buyer' } });
    expect(moot.status).toBe(200);
    expect((await listing(a.id)).status).toBe('Ended');

    // The ordinary case.
    calls = [];
    withdrawAnswer = () => json({ listingId: '110555000999' });
    await getTestDb()`UPDATE ebay_listings SET status = 'Listed', end_reason = NULL, end_note = NULL, ended_at = NULL WHERE id = ${a.id}`;
    const ok = await api('POST', `/api/ebay/listings/${a.id}/end`, { token, env: EBAY_ENV, body: { reason: 'no_buyer' } });
    expect(ok.status).toBe(200);
    expect(called('POST', '/sell/inventory/v1/offer/off-9/withdraw')).toHaveLength(1);
    expect((await listing(a.id)).status).toBe('Ended');
  });

  it('a price change on a published listing is revised on eBay, and an eBay refusal keeps the old price', async () => {
    const { token } = await loginAs(ALEX);
    const a = await listedListing(token);
    let answer = () => json({ responses: [{ offerId: 'off-9', sku: `RS-${a.id}`, statusCode: 200 }] });
    onEbay((c) => (c.path === '/sell/inventory/v1/bulk_update_price_quantity' ? answer() : undefined));

    const ok = await api('PATCH', `/api/ebay/listings/${a.id}`, { token, env: EBAY_ENV, body: { listPrice: 39.5 } });
    expect(ok.status).toBe(200);
    const sent = called('POST', '/sell/inventory/v1/bulk_update_price_quantity')[0].body;
    expect(sent).toEqual({ requests: [{ sku: `RS-${a.id}`, offers: [{ offerId: 'off-9', price: { value: '39.50', currency: 'USD' } }] }] });
    expect(Number((await listing(a.id)).list_price)).toBe(39.5);

    answer = () => json({ responses: [{ offerId: 'off-9', statusCode: 400, errors: [{ errorId: 25017, message: 'Price too low.' }] }] });
    const no = await api<{ ebay: { message: string }[] }>('PATCH', `/api/ebay/listings/${a.id}`, {
      token, env: EBAY_ENV, body: { listPrice: 0.5 } });
    expect(no.status).toBe(422);
    expect(no.body.ebay[0].message).toBe('Price too low.');
    expect(Number((await listing(a.id)).list_price)).toBe(39.5);

    // A note edit never calls eBay.
    calls = [];
    expect((await api('PATCH', `/api/ebay/listings/${a.id}`, { token, env: EBAY_ENV, body: { notes: 'shelf B' } })).status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});

describe('eBay order sync', () => {
  beforeEach(async () => { await resetDb(); await connect(); });

  function order(listingId: string, over: Record<string, unknown> = {}) {
    return {
      orderId: '12-34567-89012', creationDate: '2026-11-20T10:00:00.000Z', lastModifiedDate: '2026-11-20T10:05:00.000Z',
      orderFulfillmentStatus: 'NOT_STARTED', orderPaymentStatus: 'PAID',
      cancelStatus: { cancelState: 'NONE_REQUESTED' }, buyer: { username: 'buyer1' },
      totalMarketplaceFee: { value: '5.20', currency: 'USD' },
      lineItems: [{
        lineItemId: '10055', sku: `RS-${listingId}`, legacyItemId: '110555000999', quantity: 2,
        lineItemCost: { value: '80.00', currency: 'USD' }, total: { value: '86.00', currency: 'USD' },
      }],
      ...over,
    };
  }
  let orders: unknown[] = [];
  beforeEach(() => {
    orders = [];
    onEbay((c) => (c.path === '/sell/fulfillment/v1/order'
      ? json({ orders, total: orders.length, offset: 0, limit: 200 }) : undefined));
  });
  const sales = async (id: string) => getTestDb()<{ id: string; status: string; qty: number; unit_price: string; fees: string }[]>`
    SELECT id, status, qty, unit_price, fees FROM ebay_sales WHERE listing_id = ${id} ORDER BY created_at`;

  it('raises a Detected sale once however often it runs, and advances the cursor', async () => {
    const { token } = await loginAs(ALEX);
    const a = await listedListing(token);
    orders = [order(a.id)];

    const first = await syncEbayOrders(env);
    expect(first).toMatchObject({ ordersSeen: 1, matched: 1, newSales: 1 });
    const second = await syncEbayOrders(env);
    expect(second).toMatchObject({ ordersSeen: 1, matched: 1, newSales: 0 });
    const rows = await sales(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'Detected', qty: 2 });
    expect(Number(rows[0].unit_price)).toBe(40);
    expect(Number(rows[0].fees)).toBe(5.2);
    // Nothing becomes a sell order on its own.
    expect((await getTestDb()`SELECT 1 FROM ebay_sales WHERE sell_order_id IS NOT NULL`).length).toBe(0);
    expect((await listing(a.id)).status).toBe('Listed');

    const [conn] = await getTestDb()<{ sync_cursor: Date; last_result: { newSales: number }; last_error: string | null }[]>`
      SELECT sync_cursor, last_result, last_error FROM ebay_connection`;
    expect(conn.sync_cursor).not.toBeNull();
    expect(conn.last_result.newSales).toBe(0);
    expect(conn.last_error).toBeNull();

    // The second run read from the first run's cursor, less the overlap.
    const filters = called('GET', '/sell/fulfillment/v1/order').map(c => c.query.get('filter'));
    expect(filters).toHaveLength(2);
    expect(filters[0]).not.toBe(filters[1]);
  });

  it('a cancelled order dismisses a Detected sale, and only flags a Confirmed one', async () => {
    const { token } = await loginAs(ALEX);
    const a = await listedListing(token, 5);
    const b = await listedListing(token, 3, 8);
    orders = [
      order(a.id),
      order(b.id, {
        orderId: '12-00000-00002',
        lineItems: [{ ...order(b.id).lineItems[0], lineItemId: '20077', legacyItemId: '110555000998', quantity: 1 }],
      }),
    ];
    await syncEbayOrders(env);
    const [saleB] = await sales(b.id);
    const confirmed = await api('POST', `/api/ebay/sales/${saleB.id}/confirm`, { token, env: EBAY_ENV });
    expect(confirmed.status).toBe(200);

    orders = orders.map(o => ({ ...(o as object), cancelStatus: { cancelState: 'CANCELED' } }));
    const r = await syncEbayOrders(env);
    expect(r.dismissed).toBe(1);
    expect((await sales(a.id))[0].status).toBe('Dismissed');
    expect((await sales(b.id))[0].status).toBe('Confirmed');
    expect(r.flags).toEqual([expect.objectContaining({ saleId: saleB.id, listingId: b.id, reason: 'cancelled_after_confirm' })]);
    const [ev] = await getTestDb()<{ note: string; actor_id: string | null }[]>`
      SELECT note, actor_id FROM ebay_listing_events WHERE listing_id = ${a.id} AND kind = 'sale_dismissed'`;
    expect(ev).toMatchObject({ note: 'cancelled on eBay', actor_id: null });

    // The flag outlives the run that saw it, until the sale stops being Confirmed.
    orders = [];
    expect((await syncEbayOrders(env)).flags.map(f => f.saleId)).toEqual([saleB.id]);
  });

  it('a sale the operator marked by hand with its order # takes the line item instead of a second copy', async () => {
    const { token } = await loginAs(ALEX);
    const a = await listedListing(token, 5);
    const manual = await api('POST', `/api/ebay/listings/${a.id}/sales`, {
      token, body: { qty: 2, unitPrice: 40, ebayOrderId: '12-34567-89012' } });
    expect(manual.status).toBe(201);
    orders = [order(a.id)];
    const r = await syncEbayOrders(env);
    expect(r).toMatchObject({ newSales: 0, linkedManual: 1 });
    const rows = await getTestDb()<{ status: string; ebay_line_item_id: string }[]>`
      SELECT status, ebay_line_item_id FROM ebay_sales WHERE listing_id = ${a.id}`;
    expect(rows).toEqual([{ status: 'Confirmed', ebay_line_item_id: '10055' }]);
  });

  it('a failed run keeps the cursor and records eBay’s error', async () => {
    const { token } = await loginAs(ALEX);
    await listedListing(token);
    handlers.unshift((c) => (c.path === '/sell/fulfillment/v1/order' ? ebayError(500, 10001, 'Internal error from eBay.') : undefined));
    await expect(syncEbayOrders(env)).rejects.toThrow(/Internal error from eBay/);
    const [conn] = await getTestDb()<{ sync_cursor: Date | null; last_error: string }[]>`SELECT sync_cursor, last_error FROM ebay_connection`;
    expect(conn.sync_cursor).toBeNull();
    expect(conn.last_error).toContain('Internal error from eBay.');

    const via = await api<{ ebay: unknown[] }>('POST', '/api/ebay/sync', { token, env: EBAY_ENV });
    expect(via.status).toBe(502);
    expect(via.body.ebay).toHaveLength(1);
  });

  it('two runs never overlap: one holding the advisory lock makes the other skip', async () => {
    const { token } = await loginAs(ALEX);
    const db = getTestDb();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${EBAY_SYNC_LOCK}, 0))`;
      await held;
    });
    for (let i = 0; i < 100; i++) {
      const [{ n }] = await db<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`;
      if (n > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await syncEbayOrders(env)).toMatchObject({ skipped: 'busy' });
    const now = await api<{ error: string }>('POST', '/api/ebay/sync', { token, env: EBAY_ENV });
    expect(now.status).toBe(409);
    expect(called('GET', '/sell/fulfillment/v1/order')).toHaveLength(0);
    release();
    await holder;

    const ok = await api<{ result: { skipped?: string } }>('POST', '/api/ebay/sync', { token, env: EBAY_ENV });
    expect(ok.status).toBe(200);
    expect(ok.body.result.skipped).toBeUndefined();
  });
});
