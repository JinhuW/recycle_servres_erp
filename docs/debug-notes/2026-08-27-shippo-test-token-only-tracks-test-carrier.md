# Shippo: a test token can only track the `shippo` test carrier

**Date:** 2026-08-27 · **Symptom:** `GET /tracks/ups/1Z999AA10123456784` with a
`shippo_test_…` token returns **HTTP 400**
`{"detail":"ups is not a valid test tracking carrier. Please use 'shippo'"}`,
even though the token authenticates fine and `GET /webhooks` returns 200.

## What is actually wrong

Nothing. Shippo test mode has no carrier connections, so it serves only its own
synthetic carrier. The token is not broken and the carrier token is not
misspelled — real UPS/FedEx/USPS numbers need a **live** (`shippo_live_…`) key.

Consequences worth knowing before debugging:

- With `SHIPPO_API_TOKEN` set to a test key, every real package logs
  `[shipping] tracking refresh failed for package …` on each tick and keeps its
  previous state. Noisy, self-healing, and **not** a client bug.
- `POST /api/packages/:id/refresh` answers **502** for the same reason. Check
  the token prefix before suspecting the endpoint.
- Registration (`POST /tracks/`) is subject to the same restriction, so
  `packages.tracking_registered_at` stays NULL for real numbers under a test
  key and the sweep retries them every tick.

## What a test token *can* prove

Auth, request shape, status normalization, and ETA parsing — end to end, via the
synthetic numbers `SHIPPO_PRE_TRANSIT`, `SHIPPO_TRANSIT`, `SHIPPO_DELIVERED`,
`SHIPPO_RETURNED`, `SHIPPO_FAILURE`, `SHIPPO_UNKNOWN` against carrier `shippo`.
All six were verified this way when the client landed. The webhook path is
provable independently, by POSTing a real `track_updated` body at
`/api/public/shippo/<secret>` — it never calls Shippo.

`packages.carrier` is `CHECK (carrier IN ('UPS','FedEx','USPS'))`, so a
`shippo`-carrier row cannot be added through the API. That constraint is not
worth widening for a test carrier; drive the client directly instead.

## Other Shippo facts verified live (2026-08-27)

- `tracking_status.status` is **uppercase** (`"DELIVERED"`).
- `eta` is a full ISO instant (`"2026-08-27T20:42:29.622Z"`), not a bare date —
  `parseEta` collapses it to UTC midnight so `fmtEta` renders a calendar date.
- `tracking_history[]` comes back **out of chronological order**. Never read
  "latest" from it; `tracking_status` is the current state.
- Shippo publishes **no** webhook signature or HMAC header. The URL secret is
  the entire credential, which is why the receiver compares it with
  `timingSafeEqual` and 404s uniformly.
