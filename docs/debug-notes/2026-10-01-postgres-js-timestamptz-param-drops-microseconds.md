# A `${x}::timestamptz` parameter loses its microseconds in postgres.js

**2026-10-01.** RS-134, the keyset cursor on the transfer-orders list. The
cursor held a full-precision timestamp (`2030-01-01T00:00:00.123005Z`), yet
page 2 always came back empty.

## The cause

postgres.js asks the server for each parameter's type. When the SQL is
`${ts}::timestamptz`, the server reports `timestamptz`, and postgres.js then
serializes the JS string with its timestamptz serializer, which goes through
`new Date(...)`. A JS Date keeps milliseconds only, so `.123005` was sent as
`.123`. `(created_at, id) < ('…00.123', …)` then excludes every row in that
millisecond, including all of page 2.

```js
await sql`SELECT (${'2030-01-01T00:00:00.123005Z'}::timestamptz)::text`
// → 2030-01-01 00:00:00.123+00
```

Formatting the cursor in SQL with `to_char(... 'US')` doesn't help on its own.
The precision is lost on the way back *in*.

## The fix

Make the server see a text parameter, then cast inside SQL:

```ts
sql`(t.created_at, t.id) < ((${cursor.ts}::text)::timestamptz, ${cursor.id}::text)`
```

## Where else it bites

Any `${…}::timestamptz` built from a string that carries sub-millisecond
precision. The other keyset routes (`activity`, `sellOrders`, `orders`) build
their cursor `ts` from a JS Date, so they are already cut to milliseconds before
this point. That is the separate "ms-truncated cursors drop rows" finding. Fix
those with `to_char(… 'US')` on the way out **and** `::text` on the way in. Doing
either one alone is not enough.
