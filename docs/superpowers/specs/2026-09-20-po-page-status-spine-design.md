# Purchase-order page — status as the spine, one home per fact

**Ticket:** RS-080 · **Date:** 2026-09-20 · **Status:** approved, in progress
· **Prototype:** https://claude.ai/artifact/8wQKpHsXEmeGusnm3tvca1

## The problem

The PO page grew one block per release, and each release put its field where
it was convenient.  The same fact now has up to three input homes:

| Fact | Where it is entered or shown today |
| --- | --- |
| Warehouse | Order details · hand-off dialog |
| Purchaser | Order details · hand-off dialog · aside "Payment detail" |
| Commission rate | Order details · hand-off dialog · aside (Rate row) |
| Paid by / method | `PaymentFields` · hand-off dialog · aside chip |
| Total cost | cost tape · footer stat · aside Cost row |
| Chat screenshot | proof panel · Submission attachments (same file, twice) |
| Source, pickup-by, tracking | **hand-off dialog only**, then read-only forever |

Two things sit under that table.  Half the page is "a form you fill and Save";
the other half is "a lifecycle whose transitions ask questions" (hand-off
dialog, status dialog), and the hand-off is a second form over the same fields
— which is also why source and tracking can't be corrected afterwards.  And
"Payment" names two unrelated things: the aside card titled *Payment detail* is
commission math, the *Payment* fields are how the vendor was paid.

## The principle

**One home per fact, organised by the question a person is asking — not by
when the feature shipped.**  Anything shown a second time is a read-only
reference that points at the home, never a second input.  The same section
list serves desktop and phone, so the shells become one design at two widths.

## The shape

### What stays

The page head and the items card — line table, add-line menu, drawer, the
receipt-style `CostTape` — are unchanged and stay first.  Products are not a
tab.

### Order status: stepper + stage panel

Its own card, always visible, directly under the items card.  The existing
stepper on top; under it a two-column *stage panel* whose body follows the
stage:

| Stage | Left | Right ("Next step") |
| --- | --- | --- |
| Draft | readiness list — *Products & cost* · *How the goods get here* · *Payment* — each unmet row a link to what fixes it | **Mark as In Transit →** opens the checkpoint |
| In Transit | the linked package's Shippo state (`PackageJourney`) with **↻ Refresh**; a local pickup shows *Collected by ‹name› · ‹date›* | "check it in at ‹warehouse›" · **Mark as Reviewing →** (warehouse-manager gate as today) |
| Reviewing / Ready to Pay / Done | stage summary; Done keeps its evidence block | the next move; existing lock / gate / revert banners live here |

**Look-back.**  Every reached step is clickable.  Clicking it swaps the panel
for a dashed *Recorded at ‹stage›* box built from the order's audit events —
Draft: when and by whom it was submitted plus the hand-off summary; In
Transit: the final journey; Reviewing: received when and by whom; Ready to
Pay: commission owed since — with a *Back to ‹current›* button.  The current
step returns to the live panel; the next step is the only forward click;
further steps stay locked.  On a closed book the look-back of a reopenable
stage carries *Reopen at ‹stage›*.

**Staging vs committing.**  Only the Draft→In Transit hand-off writes
immediately (its own transaction).  *Mark as ‹next› →* stages the move exactly
as a step click does today; the footer shows a pending pill and its primary
button reads *Save · Mark as ‹next›*, and Save posts `/advance`.  After a
successful stage move the page reloads in place instead of returning to the
list, so the In Transit panel is what the user sees right after handing off.

**Shippo.**  The package is already tracked (webhook + 45-minute poll).  The
panel adds the manual `POST /api/packages/:id/refresh` and shows the
provider's 501 message inline when tracking is off.  *Delivered* never
auto-advances the PO: delivered-to-the-door and checked-in-and-counted are
different events, so the panel turns into a "check it in" prompt.

### Five tabs

| Tab | Holds | Comes from |
| --- | --- | --- |
| Delivery | source · receiving warehouse · label / pickup · tracking + carrier or collected-by · one-line Shippo mirror | hand-off dialog fields + the warehouse select |
| Payment | paid by · method · transaction ID · proof files · bank-payments ledger (managers) | `PaymentFields` + aside ledger |
| Commission | purchaser · rate · "‹name› earns" formula · realized (managers) | Order details + aside "Payment detail" |
| Notes & files | notes · Submission files (receipts, manifests) — proof files are not repeated | Order details |
| Activity | the audit log | aside |

Tabs carry a count where natural, an **amber dot** while a Draft still needs
something on that tab, and a **blue dot** when the tab has unsaved edits.  All
panels stay mounted (hidden, not unmounted) so typing never loses focus.  The
open tab is a hash query (`#/purchase-orders/:id?tab=payment`) so a readiness
row or a colleague's link can land on it.

### Footer

Sticky inside the page: total cost (+ *incl. fees* / override note), *‹name›
earns*, *Unsaved edits: Products, Payment*, the pending stage pill, Discard,
Save.  The lines / units stats go — the items card head already shows them.

### The checkpoint

The hand-off dialog keeps its transaction (`POST /api/orders/:id/handoff`) but
stops being a second form.  Each section — Products, Delivery, Payment, and
Commission for managers — renders as a ✓ summary row when the page already
holds it, and expands to inputs only when it doesn't.  The body sent is the
same; the backend fills what is omitted from the order itself.  A PO with
everything filled in is one click.  The desktop's "save unsaved edits first"
gate stays.

### Editability

Delivery and Payment facts follow the page's one rule: editable until Ready to
Pay (the closed book).  A purchaser's change is **material** — the order goes
back to Draft and raises the manager's change-review, exactly as payment
fields do today; a manager's change is not.  Tracking edits update the linked
package in place and re-register it with Shippo.

### Phone

The two-screen structure from v1.154.0 stays.  The status card's body becomes
the same stage panel (Shippo state + Refresh, look-back on a finished step),
and a folded *Delivery* card joins the folded Payment card, its header reading
back *source · how · tracking / collector*.  Folded cards are the phone's
tabs.

## Data and API

No migration: `orders.source`, `handoff_method`, `handoff_by` (0126) and
`packages` (0094, 0106) already exist.

- `GET /api/orders/:id` — adds `package.source` and, for a Draft,
  `blockers: string[]` in display order.  `txnRequired` /
  `chatShotRequired` / `cashShotRequired` stay for older shells.
- `PATCH /api/orders/:id` — accepts `source`, `handoffMethod`, `handoffBy`,
  `trackingNumber` + `carrier` (both or neither, label only).  `handoff_by` is
  NULL unless the after-state method is `pickup`; pickup with no person is
  savable and reports `missingDelivery`.  Tracking writes the linked package
  in the same transaction: same number → no-op; a standalone package with the
  number → adopted; the number on another PO → 409 naming it; otherwise the
  current package is updated in place with its tracking columns reset, or one
  is created.  Label→pickup unlinks the package (never deletes).  All of it is
  audited as `meta_changed` and rides the `reverted` payload.
- `POST /api/orders/:id/handoff` — every field optional; the transaction
  merges body over row, then advances with **every** blocker enforced.
- `advanceOrderTx` — one `leaveDraftBlockers()` list (`noCost`,
  `missingSource`, `missingDelivery`, `missingTracking`, `missingMethod`,
  `missingTxnId`, `unknownTxnId`, `missingChatShot`, `missingCashShot`).
  `/advance` and manager stage-jumps keep refusing on the proof-of-payment and
  cost rules only, so legacy Drafts and the manager shortcut are unaffected;
  the hand-off refuses on all of them.  The PayPal pull stays in the routes,
  so `GET` never calls PayPal.
- `POST /api/packages/:id/refresh` — also allowed for the linked PO's owner.

## What was considered and dropped

- **Tabs for everything, including Products** — the items card is the part of
  the page that already worked; it stays put.
- **A rail instead of tabs** (read-only summary column) — Jinhu preferred one
  section per kind of content.
- **No dialog at all** (plain button that refuses with the checklist) — the
  checkpoint keeps the hand-off "moment" purchasers know, and costs nothing
  when the page is already filled in.
- **Freezing tracking after the first carrier scan** — a third editability
  rule on a page that already had too many.
- **Auto-advance on Delivered** — see above.
