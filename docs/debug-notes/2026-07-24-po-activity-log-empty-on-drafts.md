# PO Activity panel is empty — the draft audit gate, not a broken fetch

**Symptom.** `#/purchase-orders/PO-1355` renders the Activity card with a `0`
badge and the empty-state copy. Nothing in the console, `GET /api/orders/
PO-1355/events` returns `200 {"events":[]}`.

**It is not the frontend.** `OrderActivityLog.tsx` is fine — it fetches, it
renders, `if (!loaded) return null` only hides the card until the request
resolves. Don't go looking for a render bug.

**Root cause.** Every `writeOrderEvent` call site in `routes/orders.ts` was
wrapped in `const auditable = lifecycle !== 'draft'`. A PO in `draft` recorded
*nothing* — not creation, not line adds, not edits — so the panel was empty by
construction for the entire pre-submit life of an order. Confirmed against prod:
all 5 orders created in July with `lifecycle='draft'` had zero `order_events`
rows, while every submitted order had them.

**Why the gate existed, and why it was already obsolete.** `0037`'s comment
says it: the append-only `order_events_no_delete` trigger fires on FK CASCADE
too, and `DELETE /api/orders/:id` is draft-only — so a draft carrying audit rows
would have made the delete blow up. **`0038` fixed that** by returning `OLD`
when `pg_trigger_depth() > 1`. The gate outlived its reason by 38 migrations.
Verified the relaxed function body is live in prod before removing it.

**Fix** (v1.32.0): dropped all four `auditable` gates, added a `created` event
written by `POST /api/orders`, and backfilled `created` for existing orders in
`0076`. Test `order-audit.test.ts` now asserts the opposite of what it used to —
the old `does NOT write events while the order is still a draft` case was
encoding this bug as intended behavior.

**Traps for next time**

- A test named "does NOT do X" is not proof that not-doing-X is correct. Read
  the commit that added it and the constraint it was working around; that
  constraint may be gone.
- Dry-run backfill migrations against prod inside `BEGIN; \i …; ROLLBACK;` —
  it tells you the exact rows real data will produce without touching anything.
- `tests/part-number-canon.test.ts` fails locally with `password authentication
  failed for user "<you>"` regardless of your change. Pre-existing env gap; it
  builds its own `sql` client instead of using `tests/helpers/db.ts`. Don't
  chase it.
