// eBay Sell REST APIs the ERP uses: Inventory v1 (items, offers, locations),
// Account v1 (business policies) and Fulfillment v1 (orders). Field names are
// eBay's, so a payload here reads the same as in their docs.

import type { EbayConfig } from './config';
import type { FetchFn } from './oauth';

const TIMEOUT_MS = 20_000;
/** getOrders refuses a limit above 200. */
const MAX_ORDER_PAGE = 200;
const CONTENT_LANGUAGE = 'en-US';

// ---------------------------------------------------------------------------
// Shared shapes

/** eBay money: the value is a decimal string. */
export interface EbayAmount {
  value: string;
  currency: string;
}

export interface EbayErrorDetail {
  errorId: number;
  domain?: string;
  category?: string;
  message: string;
  longMessage?: string;
  parameters?: Array<{ name: string; value: string }>;
}

/** A non-2xx answer. `errors` is eBay's own list, meant to be shown verbatim. */
export class EbayApiError extends Error {
  constructor(
    readonly status: number,
    readonly errors: EbayErrorDetail[],
    readonly method: string,
    readonly path: string,
  ) {
    super(
      errors.length
        ? errors.map((e) => e.longMessage || e.message).join(' / ')
        : `eBay ${method} ${path} failed: HTTP ${status}`,
    );
    this.name = 'EbayApiError';
  }
}

/** 429: eBay's call quota is spent. Callers stop and try on the next run. */
export class EbayRateLimitError extends EbayApiError {
  constructor(
    errors: EbayErrorDetail[],
    method: string,
    path: string,
    /** Seconds from Retry-After, when eBay sent one. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(429, errors, method, path);
    this.name = 'EbayRateLimitError';
  }
}

// ---------------------------------------------------------------------------
// Inventory API

export interface EbayInventoryItem {
  availability: {
    shipToLocationAvailability: { quantity: number };
  };
  /** A ConditionEnum value, e.g. USED_EXCELLENT, NEW, FOR_PARTS_OR_NOT_WORKING. */
  condition: string;
  conditionDescription?: string;
  product: {
    title: string;
    description?: string;
    aspects?: Record<string, string[]>;
    imageUrls?: string[];
    brand?: string;
    mpn?: string;
  };
}

export interface EbayListingPolicies {
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
}

/** The fields updateOffer accepts (EbayOfferDetailsWithId). It replaces the whole offer. */
export interface EbayOfferUpdate {
  availableQuantity: number;
  categoryId: string;
  listingDescription?: string;
  listingPolicies: EbayListingPolicies;
  merchantLocationKey: string;
  pricingSummary: { price: EbayAmount };
  quantityLimitPerBuyer?: number;
}

/** createOffer's body (EbayOfferDetailsWithKeys); marketplaceId and format default from the client. */
export interface EbayOfferCreate extends EbayOfferUpdate {
  sku: string;
  marketplaceId?: string;
  format?: 'FIXED_PRICE' | 'AUCTION';
}

export interface EbayWarning {
  errorId?: number;
  message?: string;
  longMessage?: string;
}

/** An offer as getOffers returns it (EbayOfferDetailsWithAll). */
export interface EbayOffer extends EbayOfferCreate {
  offerId: string;
  /** PUBLISHED or UNPUBLISHED. */
  status: string;
  /** Present once published. */
  listing?: {
    listingId?: string;
    /** e.g. ACTIVE, ENDED, OUT_OF_STOCK. */
    listingStatus?: string;
    soldQuantity?: number;
    listingOnHold?: boolean;
  };
}

export interface EbayInventoryLocation {
  merchantLocationKey: string;
  name?: string;
  /** ENABLED or DISABLED. */
  merchantLocationStatus?: string;
}

// ---------------------------------------------------------------------------
// Account API

/** Which listings a policy serves; `default` marks the account's default for that type. */
export interface EbayCategoryType {
  /** ALL_EXCLUDING_MOTORS_VEHICLES or MOTORS_VEHICLES. */
  name: string;
  default?: boolean;
}

export interface EbayFulfillmentPolicy {
  fulfillmentPolicyId: string;
  name: string;
  description?: string;
  marketplaceId?: string;
  categoryTypes?: EbayCategoryType[];
}

export interface EbayPaymentPolicy {
  paymentPolicyId: string;
  name: string;
  description?: string;
  marketplaceId?: string;
  categoryTypes?: EbayCategoryType[];
}

export interface EbayReturnPolicy {
  returnPolicyId: string;
  name: string;
  description?: string;
  marketplaceId?: string;
  categoryTypes?: EbayCategoryType[];
}

// ---------------------------------------------------------------------------
// Fulfillment API

export interface EbayLineItem {
  lineItemId: string;
  /** Absent when the listing was made without one (e.g. listed by hand on eBay). */
  sku?: string;
  /** The eBay item number. */
  legacyItemId: string;
  title?: string;
  quantity: number;
  /** Unit price × quantity, before discounts. */
  lineItemCost: EbayAmount;
  /** What the buyer paid for the line: cost + delivery + tax − discounts. */
  total: EbayAmount;
  /** NOT_STARTED, IN_PROGRESS or FULFILLED. */
  lineItemFulfillmentStatus?: string;
}

export interface EbayOrder {
  orderId: string;
  creationDate: string;
  lastModifiedDate: string;
  /** NOT_STARTED, IN_PROGRESS or FULFILLED. */
  orderFulfillmentStatus: string;
  /** PENDING, PAID, PARTIALLY_REFUNDED, FULLY_REFUNDED or FAILED. */
  orderPaymentStatus: string;
  cancelStatus: {
    /** NONE_REQUESTED, IN_PROGRESS or CANCELED. */
    cancelState: string;
    cancelledDate?: string;
  };
  buyer: { username: string };
  /** Every fee eBay deducts from the payout for this order. */
  totalMarketplaceFee?: EbayAmount;
  pricingSummary?: { total?: EbayAmount; priceSubtotal?: EbayAmount; deliveryCost?: EbayAmount };
  lineItems: EbayLineItem[];
}

export interface EbayOrderPage {
  orders: EbayOrder[];
  total: number;
  offset: number;
  limit: number;
  next?: string;
}

export interface GetOrdersParams {
  lastModifiedFrom: Date | string;
  lastModifiedTo?: Date | string;
  /** Default 50, at most 200. */
  limit?: number;
  offset?: number;
}

/** One SKU's row in bulkUpdatePriceQuantity's answer. */
interface EbayPriceQuantityResponse {
  offerId?: string;
  sku?: string;
  statusCode: number;
  errors?: EbayErrorDetail[];
  warnings?: EbayWarning[];
}

// ---------------------------------------------------------------------------
// Commerce Identity API

/** The seller behind a user token. */
export interface EbayIdentityUser {
  userId: string;
  username?: string;
}

/**
 * The account a fresh token belongs to. Served from the apiz host, and only
 * with the commerce.identity.readonly scope, so it takes the token directly
 * rather than going through a client's minted ones.
 */
export async function getIdentityUser(
  cfg: EbayConfig,
  accessToken: string,
  fetchFn: FetchFn = fetch,
): Promise<EbayIdentityUser> {
  const base = cfg.apiBase.replace('://api.', '://apiz.');
  const path = '/commerce/identity/v1/user/';
  const res = await fetchFn(`${base}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new EbayApiError(res.status, await parseErrors(res), 'GET', path);
  return (await res.json()) as EbayIdentityUser;
}

// ---------------------------------------------------------------------------

export type GetAccessToken = (opts?: { forceRefresh?: boolean }) => Promise<string>;

export interface EbayClientOptions {
  cfg: EbayConfig;
  getAccessToken: GetAccessToken;
  fetch?: FetchFn;
  marketplaceId?: string;
}

type RequestOpts = {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  contentLanguage?: boolean;
};

const iso = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString());

async function parseErrors(res: Response): Promise<EbayErrorDetail[]> {
  const body = (await res.json().catch(() => null)) as { errors?: unknown } | null;
  if (!body || !Array.isArray(body.errors)) return [];
  return body.errors.filter(
    (e): e is EbayErrorDetail => typeof e === 'object' && e !== null && 'message' in e,
  );
}

export class EbayClient {
  readonly marketplaceId: string;
  private readonly cfg: EbayConfig;
  private readonly getAccessToken: GetAccessToken;
  private readonly fetchFn: FetchFn;

  constructor(opts: EbayClientOptions) {
    this.cfg = opts.cfg;
    this.getAccessToken = opts.getAccessToken;
    this.fetchFn = opts.fetch ?? fetch;
    this.marketplaceId = opts.marketplaceId ?? 'EBAY_US';
  }

  private async request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const url = `${this.cfg.apiBase}${path}${qs.size ? `?${qs.toString()}` : ''}`;
    const send = async (token: string) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      if (opts.contentLanguage) headers['Content-Language'] = CONTENT_LANGUAGE;
      return this.fetchFn(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    };

    let res = await send(await this.getAccessToken());
    // A token revoked or expired early: mint once more, then let a second 401 surface.
    if (res.status === 401) res = await send(await this.getAccessToken({ forceRefresh: true }));

    if (res.status === 429) {
      const ra = Number(res.headers.get('Retry-After'));
      throw new EbayRateLimitError(
        await parseErrors(res), method, path, Number.isFinite(ra) && ra > 0 ? ra : null,
      );
    }
    if (!res.ok) throw new EbayApiError(res.status, await parseErrors(res), method, path);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // --- Inventory API ------------------------------------------------------

  /** PUT /inventory_item/{sku}: 201 created, 204 replaced; warnings only come back on 200. */
  async createOrReplaceInventoryItem(sku: string, item: EbayInventoryItem): Promise<void> {
    await this.request('PUT', `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, {
      body: item,
      contentLanguage: true,
    });
  }

  async createOffer(offer: EbayOfferCreate): Promise<{ offerId: string; warnings?: EbayWarning[] }> {
    return this.request('POST', '/sell/inventory/v1/offer', {
      body: { marketplaceId: this.marketplaceId, format: 'FIXED_PRICE', ...offer },
      contentLanguage: true,
    });
  }

  /** Replaces the offer; on a published one it revises the live listing. */
  async updateOffer(
    offerId: string,
    offer: EbayOfferUpdate,
  ): Promise<{ offerId?: string; warnings?: EbayWarning[] } | undefined> {
    return this.request('PUT', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, {
      body: offer,
      contentLanguage: true,
    });
  }

  async publishOffer(offerId: string): Promise<{ listingId: string; warnings?: EbayWarning[] }> {
    return this.request('POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`);
  }

  /** Ends the listing; the offer stays and can be published again. */
  async withdrawOffer(offerId: string): Promise<{ listingId?: string; warnings?: EbayWarning[] }> {
    return this.request('POST', `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`);
  }

  /** The SKU's offers on this marketplace; none is an empty list, not an error. */
  async getOffers(sku: string): Promise<EbayOffer[]> {
    try {
      const body = await this.request<{ offers?: EbayOffer[] }>('GET', '/sell/inventory/v1/offer', {
        query: { sku, marketplace_id: this.marketplaceId },
      });
      return body?.offers ?? [];
    } catch (e) {
      // eBay answers 404 for a SKU with no offers rather than an empty list.
      if (e instanceof EbayApiError && e.status === 404) return [];
      throw e;
    }
  }

  /**
   * Revises a live listing's price and/or quantity without replacing the
   * offer. The call answers 200 even when the revision failed, with the
   * outcome per SKU, so a failed row is thrown here like any other refusal.
   */
  async updatePriceQuantity(
    sku: string,
    offerId: string,
    change: { price?: number; quantity?: number; currency?: string },
  ): Promise<void> {
    const path = '/sell/inventory/v1/bulk_update_price_quantity';
    const offer: Record<string, unknown> = { offerId };
    if (change.price !== undefined) {
      offer.price = { value: change.price.toFixed(2), currency: change.currency ?? 'USD' };
    }
    if (change.quantity !== undefined) offer.availableQuantity = change.quantity;
    const request: Record<string, unknown> = { sku, offers: [offer] };
    if (change.quantity !== undefined) {
      request.shipToLocationAvailability = { quantity: change.quantity };
    }
    const body = await this.request<{ responses?: EbayPriceQuantityResponse[] }>('POST', path, {
      body: { requests: [request] },
      contentLanguage: true,
    });
    const failed = (body?.responses ?? []).find((r) => r.statusCode < 200 || r.statusCode >= 300);
    if (failed) throw new EbayApiError(failed.statusCode, failed.errors ?? [], 'POST', path);
  }

  async getInventoryLocations(): Promise<EbayInventoryLocation[]> {
    const body = await this.request<{ locations?: EbayInventoryLocation[] }>(
      'GET', '/sell/inventory/v1/location', { query: { limit: 100 } },
    );
    return body?.locations ?? [];
  }

  // --- Account API --------------------------------------------------------

  async getFulfillmentPolicies(): Promise<EbayFulfillmentPolicy[]> {
    const body = await this.request<{ fulfillmentPolicies?: EbayFulfillmentPolicy[] }>(
      'GET', '/sell/account/v1/fulfillment_policy', { query: { marketplace_id: this.marketplaceId } },
    );
    return body?.fulfillmentPolicies ?? [];
  }

  async getPaymentPolicies(): Promise<EbayPaymentPolicy[]> {
    const body = await this.request<{ paymentPolicies?: EbayPaymentPolicy[] }>(
      'GET', '/sell/account/v1/payment_policy', { query: { marketplace_id: this.marketplaceId } },
    );
    return body?.paymentPolicies ?? [];
  }

  async getReturnPolicies(): Promise<EbayReturnPolicy[]> {
    const body = await this.request<{ returnPolicies?: EbayReturnPolicy[] }>(
      'GET', '/sell/account/v1/return_policy', { query: { marketplace_id: this.marketplaceId } },
    );
    return body?.returnPolicies ?? [];
  }

  // --- Fulfillment API ----------------------------------------------------

  async getOrders(params: GetOrdersParams): Promise<EbayOrderPage> {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), MAX_ORDER_PAGE);
    const offset = params.offset ?? 0;
    const to = params.lastModifiedTo ? iso(params.lastModifiedTo) : '';
    const body = await this.request<Partial<EbayOrderPage>>('GET', '/sell/fulfillment/v1/order', {
      query: { filter: `lastmodifieddate:[${iso(params.lastModifiedFrom)}..${to}]`, limit, offset },
    });
    return {
      orders: body?.orders ?? [],
      total: body?.total ?? 0,
      offset: body?.offset ?? offset,
      limit: body?.limit ?? limit,
      next: body?.next,
    };
  }

  /** Every order modified since `since`, page by page. */
  async *iterateOrdersSince(
    since: Date | string,
    opts: { pageSize?: number } = {},
  ): AsyncGenerator<EbayOrder> {
    const limit = Math.min(opts.pageSize ?? MAX_ORDER_PAGE, MAX_ORDER_PAGE);
    let offset = 0;
    for (;;) {
      const page = await this.getOrders({ lastModifiedFrom: since, limit, offset });
      yield* page.orders;
      offset += page.orders.length;
      if (!page.orders.length || offset >= page.total) return;
    }
  }
}
