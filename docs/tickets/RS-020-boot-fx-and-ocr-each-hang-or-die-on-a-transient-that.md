---
id: RS-020
title: Boot, FX and OCR each hang or die on a transient that a retry would survive
type: bug
status: in-progress
priority: P2
created: 2026-09-03
reporter: Jinhu
branch: session/20260902-121934
pr:
version:
related: [RS-013]
---

## Ask

> Fetch all error log in the railway and see all error logs to see if it related
> to a system bugs.
> If yes, Then create an fix plan for all of them.

Then, after the triage came back and the fix plan was written:

> go head and accomplish the,

Second of three PRs from that triage. Jinhu chose the three-way split and chose
to land on `dev` rather than hotfix `main`. [RS-013](./RS-013-demo-shipping-labels-must-not-charge-a-po-and-bank-s.md)
carried the money-correctness half.

## Context

Three unrelated places where a transient does more damage than it should. Only
the third was actually seen in production; the first is the one that would hurt
most.

**A database blip during a deploy leaves production down until a human
redeploys.** The container's `CMD` chains on `&&`:
`migrate.mjs && init-admin.mjs && pnpm start`. `migrate.mjs` connects with the
postgres.js default `connect_timeout: 30` and sets `process.exitCode = 1` on
failure, so an unreachable database at boot means the server never starts.
Railway's restart policy is `ON_FAILURE` with 10 retries; after those the
service **stays down and does not recover when Postgres returns.**

Worth stating plainly: this has **not** been observed. The one
`CONNECT_TIMEOUT` in the log window came from the *runtime* pool in the health
handler (`index.ts`, `db.ts` `connect_timeout: 10`), returned a 503, and was
green again 30 seconds later — harmless, and it could not have restarted
anything, because Railway health checks gate a deployment rather than acting as
a liveness probe. The boot path is the severe version of that same transient.

**One outbound call has no timeout at all.** Every other external call in the
backend carries an `AbortSignal` — 20s for Mercury, PayPal, Shippo and
ShipSaving, 10s for the proxies, 10–30s for R2. The FX rate fetch in
`lib/fx.ts` does not, so it is bounded only by undici's ~300s default. It is
reachable from request handlers rather than only the six-hourly loop: the
manager refresh in `routes/fxRates.ts`, and — on a cold cache — from
`routes/vendorPublic.ts`, which is the **unauthenticated** vendor portal.

**A label scan gives up on the first OCR timeout.** Seen once in the window: a
purchaser waited 20 seconds over a RAM stick, got an error, re-shot it, and the
second attempt returned in 2 seconds. `OCR_TIMEOUT_MS` is a single 20s attempt
with no retry on `AbortError`. There is also no ceiling over the request: the
JSON re-ask turn issues a *fresh* 20s signal, and the R2 upload before it
carries its own 15s, so one `/api/scan/label` can legitimately occupy ~55s with
no timeout middleware above it.

## Acceptance criteria

- [ ] `migrate.mjs` retries its first connecting statement on a connection
      failure — bounded attempts with backoff — before exiting non-zero, and
      still exits 1 with a structured stderr line when `DATABASE_URL` is unset.
- [ ] The FX fetch carries an `AbortSignal` matching the 20s house standard.
- [ ] An OCR call that times out is retried once; the retry and the existing
      JSON re-ask share a single outer deadline, so one scan request cannot
      spend two full timeouts on the model.
- [ ] Existing scan behaviour is unchanged for non-timeout failures — an HTTP
      500 from the model is still not retried.

## Out of scope

- The runtime pool's `connect_timeout` and the health handler's 503. Both are
  correct as they stand; see Context.
- Adding a statement timeout to the health probe. Considered, but it guards a
  slow-query case that has not been seen, and `/api/health` returning 503 does
  not restart anything.
- Railway's restart policy itself — dashboard state, not repo-controlled (there
  is no `railway.json`).

## Notes

`openRouterImageJson` is shared with the receipt renamer, so the outer deadline
changes that path's worst case too.

Plan: `~/.claude/plans/precious-dazzling-cat.md`. Triage report:
https://claude.ai/code/artifact/a857947f-56fb-4a70-b4d5-b0ec94c6b2d8

`migrate.mjs` runs under bare `node` via type-stripping and imports
`lib/log.ts` directly, so the retry must not pull in anything that breaks
`tests/log-import-purity.test.ts`.
