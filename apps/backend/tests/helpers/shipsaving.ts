// A fake ShipSaving v2 account, so the *paid* label path can be driven through
// the real route.
//
// Why this exists: `pickShippingClient` chooses on credentials alone
// (shipping/index.ts), so there is no seam to inject a client through an HTTP
// request — every shipping test used to buy through the stub. That was fine
// while a stub purchase folded its price into orders.other_fees exactly like a
// real one. It stopped being fine when stub purchases stopped moving money:
// without this, nothing would exercise the fee fold or the void reversal at
// all, and the money path would be the one path with no test.
//
// The fake answers the four calls a buy makes — token, rates, create_and_pay,
// label download — plus void_label and tracking. Prices are deliberately
// unlike the stub's ($14.30 vs $12.45) so an assertion can never pass by
// accident on the wrong provider.

import { vi } from 'vitest';

const BASE = 'https://shipsaving.test';
const LABEL_URL = `${BASE}/labels/fake.pdf`;

/** Env overrides that make `pickShippingClient` choose the paid client. */
export const PAID_ENV = {
  SHIPSAVING_APP_KEY: 'test-app-key',
  SHIPSAVING_APP_SECRET: 'test-app-secret',
  SHIPSAVING_API_URL: BASE,
} as const;

export const PAID_RATE = {
  rateId: 'ss-usps-priority',
  carrier: 'USPS',
  service: 'Priority Mail',
  amount: 14.3,
  currency: 'USD',
} as const;

export const PAID_TRACKING_NO = 'SSFAKE0000001';

function json(data: unknown): Response {
  return new Response(JSON.stringify({ code: 'ok', data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FakeOpts = {
  /** Override the price the buy call reports, to test a quote/charge drift. */
  chargedAmount?: number;
};

/**
 * Routes ShipSaving traffic to canned answers for the rest of the test file.
 * Pair with `vi.unstubAllGlobals()` in an `afterEach`. The app itself is called
 * through `app.fetch` rather than the network, so stubbing the global is safe.
 */
export function installShipSavingFake(opts: FakeOpts = {}): void {
  const charged = opts.chargedAmount ?? PAID_RATE.amount;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.startsWith(`${BASE}/oauth2/token`)) {
      return new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 1800 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.startsWith(`${BASE}/api/shipment/batch/quick_rate`)) {
      return json([{
        request_unique_id: 'fake',
        shipment_rate_data: [{
          rate_id: PAID_RATE.rateId,
          carrier_code: 'USPS',
          service_name: PAID_RATE.service,
          service_level: 'priority',
          // A string price on purpose: v1 wired numbers as strings, which is
          // why the client runs everything through num().
          price: String(PAID_RATE.amount),
          currency: PAID_RATE.currency,
          delivery_days: '2',
        }],
      }]);
    }
    if (url.startsWith(`${BASE}/api/shipment/create_and_pay`)) {
      return json({
        shipment_no: 'SSSHIP-1',
        tracking_no: PAID_TRACKING_NO,
        currency: 'USD',
        total_fee: charged,
        label_fee: charged,
        label_urls: [LABEL_URL],
        duplicate_label: false,
      });
    }
    if (url.startsWith(`${BASE}/api/shipment/void_label`)) return json({});
    if (url.startsWith(`${BASE}/api/shipment/tracking_by_tracking_no`)) {
      return json({ status: 'in_transit', message: 'In transit', estimate_delivery_date: null });
    }
    if (url.startsWith(LABEL_URL)) {
      return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
        status: 200, headers: { 'Content-Type': 'application/pdf' },
      });
    }
    throw new Error(`unexpected fetch in test: ${init?.method ?? 'GET'} ${url}`);
  });
}
