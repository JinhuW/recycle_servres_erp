# `transfer-orders.test.ts` flakes on the two "mere Draft sell order" cases

**Status:** pre-existing, unfixed. Documented so the next person doesn't burn an
hour blaming their own diff, as happened while shipping the MCP connector work.

## Symptom

`apps/backend/tests/transfer-orders.test.ts` intermittently fails two cases:

- `POST …/reopen > reopens despite a line sitting on a mere Draft sell order`
- `DELETE …/:id — discard > discards despite a line sitting on a mere Draft sell order`

Both fail the same way — `expected 409 to be 200`. Measured on a clean
`origin/dev` with no local changes: **3 failures in 6 consecutive runs.** It is
a coin flip, so a single green run proves nothing and a single red run does not
implicate whatever you just changed.

## Why it looks like your fault

The flake rate is near 50%, so the usual bisect ritual actively misleads:
stash → pass, restore → fail, drop one file → pass. Every one of those is
noise. During the MCP work it even survived a two-way statement-level bisect of
an unrelated migration before the 4× repeat run exposed it as random.

**Before attributing a `transfer-orders.test.ts` failure to your change, run the
file 4–6 times on both trees.** One run is not a signal.

## Root cause

`transferOne()` (tests/transfer-orders.test.ts:9) picks its subject like this:

```ts
const inv = await api('GET', '/api/inventory', { token });
const line = inv.body.items.find(
  (i) => (i.status === 'Reviewing' || i.status === 'Done') && i.warehouse_id,
);
```

It takes the **first matching row of the list response**. That list is ordered
`ORDER BY l.created_at DESC` (`src/routes/inventory.ts:130`) with **no
tiebreaker**, and the seed inserts inventory lines in a tight loop, so many rows
share a `created_at` to the millisecond. Postgres is free to return tied rows in
any order, and it does vary between runs.

Meanwhile the seed also hands slices of that same sellable inventory to seeded
sell orders (`scripts/seed.mjs`, the `sample` array — statuses `Draft`,
`Shipped`, `Awaiting payment`, `Done`). So `transferOne()` sometimes picks an
item **already committed to a seeded `Shipped` / `Awaiting payment` order**.

The two failing tests then attach a *second*, `Draft` line and assert the
transfer order can still be reopened/discarded. But the guard
(`committedSellStatuses()`, `src/lib/sellCommitment.ts`) correctly sees the
pre-existing committed line and returns 409. **The route is right; the fixture's
assumption that its item has no other commitment is wrong.**

## The fix, when someone picks it up

Make the fixture choose deterministically and provably uncommitted — don't just
add a tiebreaker to the route, since that hides the fixture bug rather than
fixing it. Something like:

```ts
// Pick a line no seeded sell order already claims, so the "mere Draft"
// assertions are testing the guard rather than the seed's layout.
const line = inv.body.items.find(i =>
  (i.status === 'Reviewing' || i.status === 'Done') && i.warehouse_id
  && !committedInventoryIds.has(i.id));
```

with `committedInventoryIds` read from `sell_order_lines` joined to
`sell_orders` on `committedSellStatuses()`. Adding `, l.id` as a tiebreaker to
the inventory list's `ORDER BY` is worth doing anyway — an unstable list order
is a paging bug waiting to happen — but it only makes the flake deterministic,
not correct.
