# Events written in one transaction share a clock, so their order is undefined

**Date:** 2026-10-22 · **Area:** backend tests, `accounting_entry_events`, `order_events` · **Ticket:** RS-351

## Symptom

A new test in `apps/backend/tests/accounting.test.ts` asserted the order of an
entry's history after a draft PO with a linked commission row was deleted:

```
expected ['created', 'edited', 'unlinked', 'edited']
received ['created', 'edited', 'edited', 'unlinked']
```

The test passed on one run and failed on the next with the two last events
swapped. The code under test did the same thing both times.

## Cause

`accounting_entry_events.created_at` defaults to `NOW()`, which in Postgres is
the **transaction's** start time, not the statement's. The PO delete writes
the `unlinked` event and then nulls `bank_transactions.order_id`, whose
trigger (migration 0198) writes the sync's `edited` event — both inside the
delete's transaction, so both carry the same `created_at`. The history is
read `ORDER BY created_at, id`, and `id` is a random UUID, so the tie breaks
either way.

`order_events` is the same shape (`created_at DEFAULT NOW()`, UUID id), so
any two Activity lines written by one request have no defined order either.

## Fix

The test asserts the set, not the sequence:

```ts
expect(orphan.events.map(e => e.kind).sort()).toEqual(['created', 'edited', 'edited', 'unlinked']);
```

## Rule

- Never assert the relative order of two events the same request or
  transaction wrote. Compare sorted kinds, or assert each event's content.
- A test that needs order between two writes must put them in separate
  requests (separate transactions), which also matches how a person
  produces them.
- Do not "fix" this with `clock_timestamp()` in a migration: the existing
  rows keep their equal stamps, and a UI that reads one request's events as
  one edit is correct as it is.
