# ShipSaving: v1 apiTokens are not v2 OAuth credentials

**Date:** 2026-08-22 · **Symptom:** every `/oauth2/token` attempt on
`x-api.shipsaving.com` returns `{"error":"invalid_client"}` no matter how the
credentials are arranged (Basic header, form params, either ordering).

## What was actually wrong

ShipSaving has two separate credential systems:

| | Legacy v1 | New v2 |
| --- | --- | --- |
| Base URL | `https://api.shipsaving.com` | `https://x-api.shipsaving.com` |
| Auth | `?api_token=<60-char opaque token>` **query param** | OAuth 2.1 client credentials: `POST /oauth2/token`, `Authorization: Basic base64(appKey:appSecret)`, `grant_type=client_credentials&scope=API` → 30-min Bearer token (only the newest token per appKey stays valid) |
| Where keys come from | main ShipSaving dashboard | the separate **ShipSaving API Portal** (test + live keys, shown once at creation) |
| Key shape | no prefix | appKey starts `SS_TEST_` / `SS_LIVE_` (see the doc's example Basic header — decode it) |

The tokens on hand were **v1 apiTokens**. One was verified working against v1:
`GET https://api.shipsaving.com/api/balance?api_token=…` → 200. They can never
authenticate against v2 — `invalid_client` is not a formatting problem.

## Why the backend targets v2 anyway

- v1 has **no tracking-by-tracking-number endpoint** (`/api/shipments/get`
  wants `store_name` + `order_number`); the packages feature polls external
  labels by tracking number, which only v2's
  `GET /api/shipment/tracking_by_tracking_no` (requires `carrier_code`) serves.
- v2 test mode issues **free sample labels** — the buy path can be validated
  without spending money.

## Verified v1 facts (in case a v1 client is ever needed)

- `POST /api/rates/list` requires an `order` block: `order.warehouse_name` is
  mandatory but **any name is accepted** (auto-scoped); response is a bare
  array of `{shipment_id, rate_id, carrier, service, service_type,
  delivery_days: "4" (string), published_rate, rate (the actual charge),
  zone, …}`.
- `shipments[].weight` is **pounds** (2.0 → USPS Ground Advantage $6.99 zone
  5 Tucson→Denver). An oz-assuming client under-declares weight 16×.
- Account had USPS + DHL Express carrier accounts
  (`GET /api/carrier-account/list`).

## How to enable v2

Register on the ShipSaving API Portal, verify email, generate **test** keys
first (`SS_TEST_…`), set `SHIPSAVING_APP_KEY` + `SHIPSAVING_APP_SECRET`
(`SHIPSAVING_API_URL` only to override the default). `pickShippingClient`
falls back to the stub while they're unset.
