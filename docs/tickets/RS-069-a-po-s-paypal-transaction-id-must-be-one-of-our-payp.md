---
id: RS-069
title: A PO's PayPal transaction ID must be one of our PayPal account's transactions
type: story
status: in-progress
priority: P2
created: 2026-09-18
reporter: jinhu
branch: session/20260918-064949
pr:
version:
related: [RS-006, RS-010, RS-050]
---

## Ask

> PayPal transaction in the PO should also check against the payment in the system. It must exist in our paypal account.

## Context

RS-006 (v1.115.0) made the transaction ID required on a company-paid PO
before it leaves Draft, and deliberately stopped at presence: "fill the
existing txn-ID field — not a picker over synced bank rows". RS-010
(v1.118.0) links a typed id to the synced PayPal row when one exists, but a
typo or an invented id links nothing and is accepted. The Payments sync
(`bank_transactions`, source `paypal`) is the system's copy of our PayPal
account, so it is what "exists in our PayPal account" can be checked against.

The check sits where the presence rule sits — `advanceOrderTx`, the one door
every Draft → In Transit move goes through — not on save: a purchaser must be
able to store an id PayPal has not reported yet (Transaction Search lags up
to ~3 h) and submit later. It is live only once a PayPal account has synced
into the environment, so dev and the test suite (no PayPal keys) are
untouched. On a miss the backend pulls PayPal once before the transaction, so
a payment PayPal already reports does not wait for the six-hourly sync.

## Acceptance criteria

- [ ] A company-paid, PayPal-method PO whose `paypal_txn_id` matches no
      synced PayPal transaction is refused at Draft → In Transit with a 409
      naming the id, through `/advance`, `/handoff` and the carrier poll.
- [ ] A matching synced transaction lets it through (linked/ignored/pending
      state does not matter).
- [ ] On a miss, when PayPal is configured, the backend pulls PayPal once
      before deciding.
- [ ] Environments with no synced PayPal account (dev, tests) are unaffected.
- [ ] Cash, self-paid and pre-cutoff POs are unaffected.

## Out of scope

- Refusing an id that is already linked to a *different* PO (a duplicate, not
  a missing payment) — separate rule if wanted.
- Treating a denied/reversed PayPal row as "not existing" — it exists; the
  Payments page already flags its settlement state.
- Checking on save (PATCH/create) or on a manager's post-Draft edit — the
  presence rule doesn't either; the id is checked where the PO commits.
- A translated error / `code` field — none of the sibling rules carry one.
- Live per-id lookup against PayPal's API instead of the synced table.

## Notes

- Plan: `~/.claude/plans/zesty-sniffing-patterson.md`.
- Deployed dev has no PayPal keys, so the rule is off there; the first real
  exercise is prod. Before the dev → main release, read prod for post-cutoff
  company/PayPal Draft POs whose id matches no synced row — each becomes
  unsubmittable the moment the rule ships.
