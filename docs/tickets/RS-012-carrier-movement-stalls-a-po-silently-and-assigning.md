---
id: RS-012
title: Carrier movement stalls a PO silently, and assigning a paired payment can 500
type: bug
status: done
priority: P1
created: 2026-09-02
reporter: Jinhu
branch: session/20260831-225948
pr: 244
version: 1.119.1
related: [RS-006, RS-011]
---

## Ask

> /code-review high dev vs main. once it is ready and push to prod.

The review returned eight findings.  Asked which of the two medium ones to
carry, the answer was:

> Fix both, then ship

— so the two land on `dev` as a patch and the `dev` → `main` release follows,
rather than shipping the release with them known and open.

## Context

Prod runs v1.114.1; `dev` is at v1.119.0, so the cut carries five releases —
RS-006 through RS-011.  The release gate itself was clean (version, changelog
header, tag, migration numbers all line up), and the six remaining findings are
cosmetic or low-severity.  These two are not: one hides a business rule failing,
the other is a 500.

Both are in the code those five releases added.

### 1 — carrier movement stalls a Draft PO with nothing logged

RS-006 gave `advanceOrderTx` a `missingTxnId` outcome: a company-paid PO may not
leave Draft until it names the payment that funded it.  The rule is deliberately
held against *every* actor, the carrier poll included.

The carrier path discards the outcome (`shipping/track.ts:96`), and
`missingTxnId` returns before any write, so the shipment row commits as
in-transit or delivered while the PO stays in Draft — no log line, nothing
surfaced.  The human path answers 409 (`routes/orders.ts:2478`); the carrier
path is the only silent one.  "Carrier movement moves a Draft PO to In Transit"
simply stops applying, and the first anyone knows is someone wondering why a
delivered PO is still a draft.

### 2 — `POST /:id/assign` 500s on a half-linked pair

`groupOf` returns both legs of a paired payment ordered `source DESC`, which is
deterministic: the PayPal leg is always `group[0]`.  `/assign` tests only that
leg, so a pair whose **Mercury** leg is linked and whose PayPal leg is not
passes the guard, and the `UPDATE … WHERE id IN (all legs)` writes `assignee_id`
onto the linked leg — violating the CHECK added in `0116` and 500ing.

That state is reachable two ways: a counterparty transfer rule flips only the
PayPal leg to `transfer` and `linkPaypalTxnToOrder` skips it, or a leg ignored
before pairing stays ignored (`POST /:id/pair` does not check `ignored`) and is
skipped the same way.  `POST /:id/link` already tests the whole group for
`internal_txn_id`; `/assign` did not follow it.

`/unlink` reads the same first leg, so it answers "Not linked" for the very
group `/assign` refuses — leaving no way out without the second fix.

## Acceptance criteria

- [x] A company-paid PO with no transaction ID that the carrier reports moving
      stays in Draft **and** writes a `log.warn` naming the order, the shipment
      and the tracking number.
- [x] `POST /api/bank-transactions/:id/assign` on a pair whose Mercury leg is
      linked answers 400, not 500.
- [x] `POST /api/bank-transactions/:id/unlink` on that same pair succeeds.
- [x] Regression tests cover both, and the test for the first asserts the
      warning fired — not merely that the PO stayed in Draft.

## Out of scope

- **Notifying the PO owner** when a stall happens.  Cheap to build (`track.ts`
  already imports `notify`, `kind` is free-form, no i18n needed), but who should
  be told is a product decision, not a release fix.  This change makes the stall
  visible in the log; it does not make it self-healing.
- The six low-severity findings from the same review.
- The four `console.warn` calls already in `track.ts`.  The new line goes
  through `lib/log.ts` per convention; converting the others is unrelated.

## Notes

Three further handlers (`/ignore`, `/mark-transfer`, `/link`) read the same
first leg as a group-wide predicate.  None can 500 — they write a merely wrong
state — but they are the same one-word bug in the same family, fixed here rather
than left as known-bad copies of the line being corrected.

`groupOf`'s PayPal-first ordering is load-bearing (the feed's display row and
`/link`'s payment-vs-refund verdict both read it), so the fix is to test the
group, never to reorder it.
