# ShipSaving API: v1 ↔ v2 endpoint comparison

Compiled 2026-08-22 from docs.shipsaving.com (v1 openapi listing, v2 openapi
group pages, v2 appendix). Rule adopted for this backend: **wherever v2 offers
the capability, use v2; v1 is never called.** The adapter
(`apps/backend/src/shipping/shipsaving.ts`) is v2-only, and this table is the
proof there is nothing it needs from v1.

## Platform differences

| | Legacy v1 | New v2 |
| --- | --- | --- |
| Base URL | `https://api.shipsaving.com` | `https://x-api.shipsaving.com` |
| Auth | `?api_token=` query param (dashboard token) | OAuth 2.1 client credentials → 30-min Bearer (`SS_TEST_`/`SS_LIVE_` keys from the API Portal) |
| Sandbox | separate Postman env, no free labels documented | test mode with **free sample labels** |
| Idempotent buys | none | `platform_uk_id` dedupes purchases |

## Endpoint map (every endpoint of both versions)

| Capability | v1 | v2 | Winner / our usage |
| --- | --- | --- | --- |
| Get rates | `POST /api/rates/list` (requires an `order.warehouse_name`; weights in **lb**) | `POST /api/shipment/batch/quick_rate` (addresses+package inline, explicit units) and `POST /api/shipment/get_rates` (account-context) | **v2** — we call `batch/quick_rate` |
| Buy label from a rate | `GET /api/rates/buy?rate_id=` | `POST /api/shipment/create_and_pay` (`platform_uk_id` idempotency, PNG label URLs) | **v2** — we call `create_and_pay` |
| Direct buy (skip rates) | `POST /api/rates/buy-label` | `POST /api/shipment/direct_buy` | **v2** if ever needed — unused today |
| Void label | `POST /api/shipments/void` (by tracking number) | `POST /api/shipment/void_label` (by `shipment_no` / `platform_uk_id`) | **v2** — we call `void_label` |
| Tracking by tracking number | **none** (v1's `GET /api/shipments/get` returns label details by store+order, not tracking events) | `GET /api/shipment/tracking_by_tracking_no` (+ `/direct/` UTC-offset variant, + `tracking_by_platform_uk_id`) | **v2 only** — the poll depends on it (shipments *and* external packages) |
| Address validation | `POST /api/addresses/verify` | `POST /api/address/validate` | **v2** if ever needed — unused |
| USPS SCAN form | `POST /api/shipments/scan-forms/create` | `POST /api/scan_form/create_scan_form` | **v2** if ever needed — unused |
| Insurance quote | none | `GET /api/shipment/insurance/rate` | v2-only — unused |
| Proof of delivery | none | `POST /api/shipment/submit_pod` | v2-only — unused |
| USPS carrier pickups | none | `POST /api/shipment/pickup/add`, `POST …/cancel`, `GET …/list`, `GET …/package/location/list` | v2-only — unused |
| Auth token | n/a (static token) | `POST /oauth2/token` | **v2** — we call it |
| Pre-create order records | `POST /api/orders/create`, `DELETE /api/orders/delete` | none — v2 keys shipments by `platform_uk_id` instead | v1-only; **not needed** (our PO ids are the `platform_uk_id`) |
| Label details by store/order | `GET /api/shipments/get` | superseded by `create_and_pay` response (label URLs) + `tracking_by_platform_uk_id` | not needed |
| DHL eCommerce SCAN forms | `POST /api/shipments/scan-forms/dhl/ecommerce/create`, `GET …/get` | none | v1-only; unused (no DHL eCommerce workflow) |
| Carrier accounts list | `GET /api/carrier-account/list` | none | v1-only; unused (handy for one-off account checks) |
| Account balance | `GET /api/balance` | none | v1-only; unused (visible in the dashboard) |

## Conclusion

- Every capability this backend uses — **rates, buy, void, tracking** — exists
  in v2, so v2 is used for all of them; tracking-by-number exists *only* in
  v2, which is what makes v2 mandatory for the packages feature.
- The endpoints that exist only in v1 (order records, DHL eCommerce SCAN
  forms, carrier-account list, balance) are all outside this system's scope.
  If one is ever needed, it would require the v1 `api_token` alongside the v2
  keys — keep that in `docs/debug-notes/2026-08-22-shipsaving-v1-token-vs-v2-oauth.md`'s
  verified-v1-facts section in mind before building it.
- The v2 appendix pins the `carrier_code` / `provider_id` / `service_level`
  relationships (USPS_B, UPS_SS_DNI, FEDEX_X, DHL_A, …) the adapter's carrier
  mapping relies on; we request rates unfiltered, so only `carrier_code`
  handling matters to us.
