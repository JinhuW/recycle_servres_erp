---
id: RS-130
title: Code-review fixes: criticals, quick majors, vendor portal removal, cleanup
type: bug
status: in-progress
priority: P1
created: 2026-10-01
reporter: jinhu
branch: fix/review-criticals
pr:
version:
related: []
---

## Ask

> start the fix implementation work.

> pls also clena up usless files.

Answers to the scoping questions:

> How much should this first fix PR cover? — Criticals + quick Majors

> For C2 (the general vendor link shows every vendor all bids), how should 'My offers' work on a general link? — remove the bid, since not one is really using it

> "Remove the bid": which part should go? — Whole vendor bid portal

> Which 'useless files' should I clean up? — Dead code in the repo, Stale session worktrees, Main checkout strays

## Context

A full multi-area code review of `origin/dev` at v1.189.2 (2026-10-01) found
three Critical issues and about forty Major ones. This ticket is the first
batch: the Criticals, plus the Majors that were small enough to ship alongside
them.

- **C1** — `POST /api/inventory/transfer` checked a move only against the line's
  `qty`, never against what committed (Shipped / Awaiting payment) sell orders
  had reserved. A partial move split reserved units off into a clone, so when
  the sell order went Done the clone stayed as stock that physically wasn't
  there. `PATCH /inventory/:id` already refused this; the transfer did not.
- **C2** — the general (customer-less) vendor link is one URL shared with every
  vendor, and `GET /api/public/vendor/:token/bids` listed every bid made through
  it, so each vendor saw the others' names, notes and prices. Prod had 3 links
  (last opened 2026-08-04) and **zero bids ever**, so the whole portal goes
  rather than being fixed.
- **C3** — migration 0042 created a `metrics` login with the password `metrics`
  on every cluster, prod included, and prod Postgres is reachable through a
  public TCP proxy. Revoked on prod by hand on 2026-10-01
  (`ALTER ROLE metrics NOLOGIN PASSWORD NULL`); migration 0141 makes it stick
  everywhere.
- **M1** — `readSafeNext` let `?next=/%09/evil.com` through; browsers strip the
  tab and navigate off-site.
- **M11** — `orders.payment` was never validated on create / draft / PATCH, and
  every proof-of-payment rule tests `=== 'company'` or `=== 'self'`, so any
  other string skipped all of them.
- **M19** — deleting a Draft PO that had a linked bank transaction failed with
  a 500: `ON DELETE SET NULL` nulled only `order_id` and tripped the paired
  CHECKs. Four prod drafts were in that state.
- **M29** — changing your password logged you out. The `rt` cookie is scoped to
  `/api/auth`, so `/api/me/password` never saw it and revoked every family,
  the caller's included.

## Acceptance criteria

- [ ] A transfer of more units than `qty − committed` is refused with 409, for
      partial and full moves alike; an uncommitted remainder still moves.
- [ ] The `metrics` role cannot log in on any cluster after migrations; the
      compose exporter is behind a `metrics` profile.
- [ ] `/api/public/vendor/*`, `/api/vendor-bids`, the customer vendor-link
      endpoints, the `/v/<token>` app and the Vendor Bids page are gone; the
      three vendor tables and `id_counters` 'VB' row are dropped.
- [ ] The sell-order bid sheet (price template / import) still works.
- [ ] `readSafeNext` rejects control characters and anything that resolves
      off-origin.
- [ ] `payment` other than `company` / `self` is refused with 400 at create,
      draft, PATCH and handoff, and a DB CHECK enforces it.
- [ ] A linked Draft PO deletes with 200 and its bank rows come back unlinked.
- [ ] Changing your password keeps the current session and revokes the others.
- [ ] The dead `/api/attachments` route and its table are gone.

## Out of scope

- The remaining Majors from the review. They go in themed batches: public
  surface hardening, stock math and lock order, then input validation and the
  `orders.ts` split.
- A full move of a line that only a *Draft* sell order names still sends it to
  In Transit and leaves that draft unpromotable — existing behaviour.
- Transfer vs. sell-order promotion deadlocks across two or more lines — the
  lock-order batch.

## Notes

Plan: `~/.claude/plans/optimized-watching-map.md` (reviewed by one Plan agent,
five changes applied). The `metrics` role is cluster-wide, so the shared test
cluster at :55432 keeps it NOLOGIN for every worktree once this suite runs; see
the debug note.
