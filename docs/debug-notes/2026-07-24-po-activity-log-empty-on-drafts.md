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

**Three things the fix had to drag along.** None were obvious up front:

1. `summary()` in `OrderActivityLog.tsx` had no `default:` branch. It is
   exhaustive over the compile-time union, so an event kind the loaded bundle
   has never seen returns `undefined` and `s.title` throws — and there is no
   ErrorBoundary above it (`main.tsx` is a bare `createRoot`), so the *whole
   app* goes blank, not just the panel. Railway and the Cloudflare Worker
   deploy independently, so every backend that adds an event kind opens that
   window. Adding a kind means adding a `default:` first.
2. Auditing drafts exposed an amplifier: `DesktopSubmit.tsx`'s `persistLines`
   re-sends the full `wireMeta()` — including a `totalCost` that grows with
   each line — on every confirm. Measured: a 6-line build wrote 5 junk
   `meta_changed` rows. Suppressed when `total_cost` is the only delta on a
   draft.
3. `0076` runs before `seed.mjs`, so on a fresh dev DB it backfills nothing
   and every demo PO still showed an empty panel — the bug would look
   unfixed to the next reviewer. `seed.mjs` now writes the event itself.

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
- `pnpm db:seed` on a DB you've been clicking around in dies on
  `vendor_bid_lines_inventory_id_fkey` — the wipe order doesn't clear vendor
  bids. Also pre-existing. Seed into a scratch database instead of debugging it.
