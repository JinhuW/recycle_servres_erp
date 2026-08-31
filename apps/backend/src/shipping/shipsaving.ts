// ShipSaving New API (v2) client — docs.shipsaving.com/v2.
//
// Auth is OAuth 2.1 client credentials: appKey:appSecret exchanged at
// /oauth2/token for a Bearer access_token. Tokens live 30 minutes and only
// the most recently issued token per appKey is valid, so this module caches
// one token and re-mints on expiry or a 401.
//
// Endpoint map:
//   rates     POST /api/shipment/batch/quick_rate   (addresses + package inline)
//   buy       POST /api/shipment/create_and_pay      (rate_id + platform_uk_id)
//   void      POST /api/shipment/void_label          (shipment_no | platform_uk_id)
//   tracking  GET  /api/shipment/tracking_by_tracking_no?tracking_no=&carrier_code=

import type { Env } from '../types';
import type {
  BuyContext, PurchasedLabel, RateQuote, ShipAddress, ShipPackage,
  ShippingClient, TrackingInfo, VoidRef,
} from './types';
import { parseEta } from './types';

const DEFAULT_BASE = 'https://x-api.shipsaving.com';
const TIMEOUT_MS = 20_000;
// Tokens last 30 min; refresh with headroom.
const TOKEN_TTL_MS = 25 * 60 * 1000;

type Envelope<T> = { code?: string; msg?: string; data?: T };

// One cached token per appKey — minting a new token invalidates the previous
// one account-wide, so eagerly re-minting per request would self-DoS.
// Mints are single-flighted for the same reason: two concurrent callers each
// minting would invalidate each other's token and ping-pong 401s.
const tokenCache = new Map<string, { token: string; expires: number }>();
const mintInFlight = new Map<string, Promise<string>>();

function base(env: Env): string {
  return (env.SHIPSAVING_API_URL ?? DEFAULT_BASE).replace(/\/$/, '');
}

function mintToken(env: Env): Promise<string> {
  const key = env.SHIPSAVING_APP_KEY ?? '';
  const inFlight = mintInFlight.get(key);
  if (inFlight) return inFlight;
  const p = (async () => {
    const secret = env.SHIPSAVING_APP_SECRET ?? '';
    const res = await fetch(`${base(env)}/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${key}:${secret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'API' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; error?: string }
      | null;
    if (!res.ok || !body?.access_token) {
      throw new Error(`shipsaving oauth2/token failed: HTTP ${res.status} ${body?.error ?? ''}`.trim());
    }
    tokenCache.set(key, { token: body.access_token, expires: Date.now() + TOKEN_TTL_MS });
    return body.access_token;
  })().finally(() => mintInFlight.delete(key));
  mintInFlight.set(key, p);
  return p;
}

async function getToken(env: Env): Promise<string> {
  const cached = tokenCache.get(env.SHIPSAVING_APP_KEY ?? '');
  if (cached && cached.expires > Date.now()) return cached.token;
  return mintToken(env);
}

// After a 401: someone else may have already re-minted (invalidating the token
// this call used) — retry with the newer cached token before minting again.
async function freshToken(env: Env, usedToken: string): Promise<string> {
  const cached = tokenCache.get(env.SHIPSAVING_APP_KEY ?? '');
  if (cached && cached.token !== usedToken && cached.expires > Date.now()) return cached.token;
  return mintToken(env);
}

async function call<T>(
  env: Env,
  method: 'GET' | 'POST',
  path: string,
  opts: { body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query)}` : '';
  const doFetch = (token: string) => fetch(`${base(env)}${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const token = await getToken(env);
  let res = await doFetch(token);
  if (res.status === 401) res = await doFetch(await freshToken(env, token));
  if (!res.ok) {
    throw new Error(`shipsaving ${method} ${path} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  }
  const envelope = (await res.json()) as Envelope<T>;
  if (envelope.code && envelope.code !== 'ok') {
    throw new Error(`shipsaving ${method} ${path} returned ${envelope.code}: ${envelope.msg ?? ''}`.trim());
  }
  return envelope.data as T;
}

// carrier_code enum ↔ the display names stored on our rows.
const CARRIER_DISPLAY: Record<string, string> = {
  USPS: 'USPS',
  UPS: 'UPS',
  FEDEX: 'FedEx',
  DHL_EXPRESS: 'DHL',
};
const CARRIER_CODE: Record<string, string> = {
  usps: 'USPS',
  ups: 'UPS',
  fedex: 'FEDEX',
  dhl: 'DHL_EXPRESS',
};

function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  // last_name is required — a single-word name repeats as both halves.
  return { first: parts[0] ?? name, last: parts.slice(1).join(' ') || (parts[0] ?? name) };
}

function toAddressData(a: ShipAddress) {
  const { first, last } = splitName(a.name);
  return {
    first_name: first,
    last_name: last,
    ...(a.phone ? { phone: a.phone } : {}),
    street: a.street1,
    ...(a.street2 ? { street2: a.street2 } : {}),
    city: a.city,
    state: a.state,
    zip_code: a.zip,
    country: a.country || 'US',
  };
}

// The wire shapes are declared from the docs but have never been verified
// against a live account (tokens pending) — every number passes through num()
// because v1 demonstrably wired numbers as strings ("delivery_days": "4").
function num(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

type WireRate = {
  rate_id: string;
  carrier_code: string;
  service_name: string;
  service_level: string;
  price: number | string;
  currency: string;
  delivery_days: string | null;
};

type WireBuy = {
  shipment_no: string;
  tracking_no: string;
  currency: string;
  total_fee: number | string;
  label_fee: number | string | null;
  label_urls: string[] | null;
  duplicate_label: boolean;
};

type WireTracking = {
  status: string;
  message: string | null;
  estimate_delivery_date: string | null;
};

function normalizeStatus(raw: string): TrackingInfo['normalized'] {
  switch (raw) {
    case 'delivered': return 'delivered';
    case 'available_for_pickup':
    case 'in_transit':
    case 'out_for_delivery': return 'in_transit';
    case 'voided': return 'voided';
    case 'return_to_sender':
    case 'error':
    case 'seized_by_law_enforcement': return 'exception';
    // 'created' (label not yet scanned) and 'unknown' mean no movement.
    default: return 'purchased';
  }
}

export function shipSavingClient(env: Env): ShippingClient {
  return {
    provider: 'shipsaving',

    async listRates(from: ShipAddress, to: ShipAddress, pkg: ShipPackage): Promise<RateQuote[]> {
      const data = await call<Array<{ request_unique_id: string; shipment_rate_data?: WireRate[] }>>(
        env, 'POST', '/api/shipment/batch/quick_rate',
        {
          body: [{
            request_unique_id: crypto.randomUUID(),
            from_address_data: toAddressData(from),
            // Warehouses receive freight — commercial keeps residential
            // surcharges off the quotes.
            to_address_data: { ...toAddressData(to), address_type: 'commercial' },
            package_data: {
              type: 'my_package',
              length: pkg.lengthIn,
              width: pkg.widthIn,
              height: pkg.heightIn,
              dimension_unit: 'in',
              weight: pkg.weightOz,
              weight_unit: 'oz',
            },
            ship_date: new Date().toISOString(),
            // Every carrier the account has active — no filter.
          }],
        },
      );
      // A shape surprise must throw (the route converts it to a 502), not
      // read as "no carrier covers this address" — the silent-[] failure mode
      // is indistinguishable from a real empty answer.
      const rates = data?.[0]?.shipment_rate_data;
      if (!Array.isArray(rates)) {
        throw new Error('shipsaving: unexpected quick_rate response shape');
      }
      return rates.flatMap((r) => {
        const amount = num(r.price);
        if (!r.rate_id || amount === null) return [];
        return [{
          rateId: r.rate_id,
          carrier: CARRIER_DISPLAY[r.carrier_code] ?? r.carrier_code,
          service: r.service_name || r.service_level,
          amount,
          currency: r.currency || 'USD',
          deliveryDays: num(r.delivery_days),
        }];
      });
    },

    async buyByRateId(rateId: string, ctx: BuyContext): Promise<PurchasedLabel> {
      const data = await call<WireBuy>(env, 'POST', '/api/shipment/create_and_pay', {
        body: {
          rate_id: rateId,
          platform_uk_id: ctx.platformUkId,
          label_print_type: 'common',
        },
      });
      if (!data?.tracking_no) throw new Error('shipsaving create_and_pay returned no tracking number');
      // Same platform_uk_id, different rate_id → ShipSaving returns the label
      // it already sold, not a new purchase. The recorded carrier/service come
      // from the freshly picked quote, so they may not describe this label —
      // surface it for reconciliation instead of failing a charged purchase.
      if (data.duplicate_label) {
        console.warn(
          `[shipping] create_and_pay returned an existing label for platform_uk_id ${ctx.platformUkId} `
          + `(rate_id ${rateId}) — verify carrier/service against ShipSaving if the rate was re-picked`,
        );
      }

      const labelUrl = data.label_urls?.[0];
      if (!labelUrl) throw new Error(`shipsaving label ${data.tracking_no} bought but no label URL returned`);
      const labelRes = await fetch(labelUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!labelRes.ok) throw new Error(`shipsaving label download failed: HTTP ${labelRes.status}`);
      const labelData = new Uint8Array(await labelRes.arrayBuffer());
      const labelContentType = labelRes.headers.get('Content-Type')?.split(';')[0] || 'image/png';
      const labelExt = labelContentType === 'application/pdf' ? 'pdf' : 'png';

      return {
        shipmentId: data.shipment_no,
        trackingNumber: data.tracking_no,
        // v2's buy response doesn't echo the service — the stored quote the
        // rate id resolved against carries it.
        carrier: ctx.quote?.carrier ?? '',
        service: ctx.quote?.service ?? '',
        // Money is recorded (and .toFixed'd) after the charge already landed —
        // a string or missing fee must degrade to the quoted price, not crash
        // the recording step into the reconcile-manually path.
        amount: num(data.label_fee) ?? num(data.total_fee) ?? ctx.quote?.amount ?? 0,
        currency: data.currency || ctx.quote?.currency || 'USD',
        labelData,
        labelContentType,
        labelExt,
        trackingUrl: null,
      };
    },

    async voidLabel(ref: VoidRef): Promise<{ ok: boolean; message?: string }> {
      try {
        await call<unknown>(env, 'POST', '/api/shipment/void_label', {
          body: ref.shipmentNo
            ? { shipment_no: ref.shipmentNo }
            : { platform_uk_id: ref.platformUkId },
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'void failed' };
      }
    },

    async getShipment(trackingNumber: string, carrier: string | null): Promise<TrackingInfo> {
      // listRates quotes every carrier the account has active, and an unmapped
      // one is stored as its raw carrier_code (e.g. ONTRAC) — pass such codes
      // through verbatim so those labels stay trackable instead of throwing on
      // every poll tick forever.
      const name = (carrier ?? '').trim();
      const carrierCode = CARRIER_CODE[name.toLowerCase()]
        ?? (/^[A-Z0-9_]+$/.test(name) ? name : null);
      if (!carrierCode) throw new Error(`shipsaving tracking needs a known carrier, got "${carrier ?? ''}"`);
      const data = await call<WireTracking>(env, 'GET', '/api/shipment/tracking_by_tracking_no', {
        query: { tracking_no: trackingNumber, carrier_code: carrierCode },
      });
      return {
        raw: data?.message || data?.status || 'unknown',
        normalized: normalizeStatus(data?.status ?? 'unknown'),
        eta: parseEta(data?.estimate_delivery_date),
      };
    },
  };
}
