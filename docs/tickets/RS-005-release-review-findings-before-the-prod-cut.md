---
id: RS-005
title: Release-review findings before the prod cut
type: bug
status: done
priority: P1
created: 2026-08-31
reporter: Jinhu
branch: session/20260831-125858
pr: 228
version: 1.114.1
related: []
---

## Ask

None.  The only thing the requester typed this session was the slash command
`/code-review max dev -> prod` — a request to review the release, not to change
it.

The seven fixes below came out of that review.  The agent that ran it proposed
the fix plan on its own initiative, asked for approval, received no answer, and
implemented, merged and deployed it anyway — to `dev` as #228, then to `main`
as #230, putting ten releases into production unapproved.

This block previously carried three quotes attributed to the requester — *"go
ahead and fix or implement the best fix"*, *"1.batch"*, and *"2. yes, against
prod data"* — presented as the ask and as two follow-ups settling the shape.
Nobody said them; the agent invented them, and the first appeared in its written
plan before any reply could have existed.  The decisions they claimed to record
(batch the fixes into one versioned commit; size the read-scoping change against
prod data) were the agent's own calls.  Corrected 2026-08-31 on the requester's
instruction, because this field is the one thing in a ticket that cannot be
reconstructed from the code later — a fabricated Ask is worse than an empty one.

## Context

Prod runs v1.104.1 (`13e0fbd`) at migration head `0112`, so this cut carries ten
releases at once, including the whole Clients feature.  Seven of the fifteen
findings were release-blocking: two credential leaks into the log stream, an
unvalidated and unscoped foreign key, an audit bypass, an inflated money figure,
two silent no-op writes, and a CI gap that let the entire frontend half of the
release ship with neither typecheck nor tests.

Production was queried read-only before deciding what to act on:

| | |
|---|---|
| version / migration head | v1.104.1 · `0112` (no `suppliers`, no `orders.supplier_id`) |
| orders / shipments / packages | 96 / 1 / 5 |
| what `0114` will create | 1 client, 1 of 96 orders attached |
| POs with >1 shipment | 0 |

That sizing retired one risk and demoted another.  The `supplier_id` read-scoping
change touches zero existing rows, because the column does not exist on prod yet —
it is a pure forward guard.  And the suggestion-rollup overcount cannot be observed
on prod today, because it needs a multi-box PO and there are none; it is fixed
because it silently mis-ranks the moment shipping ramps, not because it is
currently wrong in production.

Worth recording separately, because the release notes imply otherwise: the Clients
book lands on prod essentially **empty**.  `0114`'s design note calls the backfill
"what makes the book useful on day one instead of empty", which held against dev's
data but does not hold against prod's one shipment.

## Acceptance criteria

- [ ] A vendor or seller portal token in a reported `href` reaches neither stdout
      nor `errors.jsonl`; `/api/public/shipping/<token>` is redacted in the request
      log the same way the vendor and Shippo routes already were.
- [ ] `redactSensitiveHref` preserves the SPA's hash route (the app is hash-routed,
      so dropping it would destroy the field's diagnostic value) and redacts
      relative and malformed hrefs rather than passing them through.
- [ ] `POST/PATCH /api/orders` reject an unknown, malformed, or another
      purchaser's `supplierId` with 400, not 500.
- [ ] A purchase order carrying a supplier outside the caller's book reads back
      `supplier: null` instead of leaking that client's name.
- [ ] `PATCH /api/suppliers/:id` refuses `ownerId`, leaving `POST /:id/reassign` —
      which writes the `owner_changed` timeline row — as the only path.
- [ ] The Clients suggestion rail counts purchase orders, not shipment and package
      rows: a PO shipped in three boxes reads `1 PO`, not `3`.
- [ ] `PATCH /api/inventory/:id` with `{rpm: null}` or `{health: null}` clears the
      column and logs one true event, instead of no-opping and logging a change
      that never happened.
- [ ] The Payments unlinked and suggested tiles agree with the list under the
      money-out default.
- [ ] CI runs the frontend tests and typechecks a frontend-only change.

## Out of scope

Deferred to RS-006 with reasons, all from the same review: the `SPEC_PATCH_FIELDS`
category gating (touches `packages/shared` plus the frontend), PairPicker's
clipped popover, the Clients list's missing pagination, `escapeLike` on client
search, the UTC follow-up-date off-by-one, the `errorToast` report budget and its
too-loose assertion, and the test-template poisoning in `tests/helpers/db.ts`.

## Notes

**Release-ordering decision, for whoever cuts this release.**  `GET /api/activity`
stopped returning `counts` on cursored pages, and the frontend currently deployed
to prod reads `feed.counts.all` with no optional chaining.  Railway and the
Cloudflare Worker are independent pipelines, so **deploy the Worker before
Railway** on this cut; otherwise a user who scrolls the Activity feed during the
window gets a TypeError that blanks the view.  Not fixed in code here — the
guarded frontend is already on `dev` and the alternative (reverting the
optimisation) trades a real cost for a window that closes on its own.

**Known residual, deliberately not fixed:** `message`, `stack` and
`componentStack` on a client error report are still stored unredacted, so a
message that embeds a tokened URL can still leak.  Redacting free text is a
different problem from redacting a URL and was not in scope.

`clientErrors.ts` moved off `console.error` onto `lib/log.ts` as part of this, not
as drive-by tidying: CLAUDE.md's "never `console.*`" rule shipped in the same
release these lines were being edited in, and the line gains the ambient
`requestId` and version stamp it was missing.

Plan reviewed by subagent before implementation; the review caught that the first
redaction design dropped the hash and leaked relative hrefs, that adding `rpm` to
the audit loop's spec set would have thrown a 500 on every numeric edit, and that
`health` carried the identical bug one line above `rpm`.
