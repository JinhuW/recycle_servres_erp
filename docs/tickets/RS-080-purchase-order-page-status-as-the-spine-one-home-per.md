---
id: RS-080
title: Purchase-order page: status as the spine, one home per fact
type: story
status: in-progress
priority: P2
created: 2026-09-20
reporter: jinhu
branch: feat/po-page-spine
pr: 369
version:
related: [RS-050, RS-071, RS-077, RS-078]
---

## Ask

> you are an expertise in the UIUX deisgn.
>
> ultrathink help me think of how this worklfow should be.
>
> cuz i hope user can submit all related order info. include payments, shipping and modify them if needed.
>
> this the desktop view, But also the mobile view. There are lots of duplicated location are showing same info.

Later in the same conversation, after seeing the prototype:

> I like the idea for showing different section for different content.
> But i still hope to keep "Order status" in individual sections.
>
> also while in transit status, I hope use the shipppo api to track the package status.
> refine your plan.

> The product detail should keep current system design.
> But i like the remain change

> pls keep this section as it: [screenshot: page head + items card with the cost breakdown]

> only update this part. [screenshot: status stepper → order details → payment → notes → attachments → footer]

## Context

The desktop PO edit page (`pages/desktop/DesktopEditOrder.tsx`) grew one block
per release. Today the same fact is entered or shown in up to three places:
warehouse, purchaser and commission rate sit in *Order details* **and** in the
Draft→In Transit hand-off dialog (v1.142.0) **and** — for purchaser and rate —
in the aside's "Payment detail" card; paid-by is in `PaymentFields`, the
hand-off, and the aside chip; total cost is on the cost tape, the footer, and
the aside; a self-paid chat screenshot appears in the proof panel and again in
*Submission attachments*. "Payment detail" is actually commission math, while
*Payment* is how the vendor was paid. The facts the hand-off collects — source,
pickup vs label, who collected it, tracking number — are written once by
`POST /api/orders/:id/handoff` and can never be edited afterwards, even though
`orders.source / handoff_method / handoff_by` (migration 0126) and the linked
`packages` row are ordinary columns. The linked package is already tracked
through Shippo (webhook + 45-minute poll, `POST /api/packages/:id/refresh`),
but the PO page shows the journey with no way to ask for an update.

The phone (`pages/OrderDetail.tsx`, v1.154.0) already has half the intended
shape — a *Before you submit* list and payment folded behind a header that
reads back the answer — with its own copy of the readiness rule
(`handoffBlockerKeys` + inline rows); the desktop has a third partial copy
(`txnBlocked` / `cashShotBlocked`). The backend evaluates all leave-Draft
rules in one place (`advanceOrderTx`).

Design settled in the brainstorm and recorded in
`docs/superpowers/specs/2026-09-20-po-page-status-spine-design.md`, prototype
at https://claude.ai/artifact/8wQKpHsXEmeGusnm3tvca1.

## Acceptance criteria

Backend (PR-A)
- [x] `PATCH /api/orders/:id` accepts `source`, `handoffMethod`, `handoffBy`,
      and `trackingNumber` + `carrier`; they are audited under `meta_changed`
      (names, not ids) and count as material edits for a purchaser.
- [x] A tracking change updates the linked package in place (tracking status
      reset, re-registered with Shippo); a number already tracked on another
      PO is refused with a 409 naming it; a standalone package with that
      number is adopted; switching to pickup unlinks (never deletes) the
      package.
- [x] `GET /api/orders/:id` returns `blockers: string[]` for a Draft, computed
      by the same function the advance uses; `package.source` is included.
- [x] `POST /api/orders/:id/handoff` accepts a partial body and fills the rest
      from the order; it refuses on every blocker, while `/advance` and manager
      stage-jumps keep refusing only on the proof-of-payment and cost rules.
- [x] The PO's owner can call `POST /api/packages/:id/refresh` on the linked
      package.

Frontend, shared (PR-B1)
- [ ] One `poReadiness` helper feeds the phone's *Before you submit* list, the
      desktop's readiness rows and tab dots, and the hand-off checkpoint.
- [ ] The hand-off dialog shows ✓ summary rows for what the order already
      holds and inputs only for what is missing; confirming still writes and
      advances in one transaction.

Desktop (PR-B2)
- [ ] The page head and the items card with its cost-breakdown tape are
      unchanged.
- [ ] Below them, *Order status* is its own card: the stepper plus a stage
      panel — Draft shows the readiness list with links to the section that
      fixes each item; In Transit shows the package's Shippo state with a
      **Refresh** button (or who collected a local pickup); later stages show
      the next step. Every reached step is clickable and shows what that stage
      recorded, read-only, with a way back.
- [ ] Five tabs follow: Delivery (source, warehouse, label/pickup, tracking or
      collector), Payment (paid by, method, proof, bank-payments ledger),
      Commission (purchaser, rate, what the purchaser earns), Notes & files,
      Activity. No fact has an input in more than one tab. Tabs carry an amber
      dot for "needed before hand-off" and a blue dot for unsaved edits.
- [ ] Delivery and Payment facts are editable until Ready to Pay; a
      purchaser's change sends the order back to Draft for change-review.
- [ ] A sticky footer shows total cost, what the purchaser earns, the unsaved
      count, Discard and Save. A stage move stays on the page.

Phone (PR-C)
- [ ] The status card carries the same stage panel (Shippo state + Refresh,
      look-back on a finished step) and a folded Delivery card whose header
      reads back the answer.

## Out of scope

- Auto-advancing In Transit → Reviewing when Shippo reports *Delivered* —
  delivered-to-the-door and checked-in-and-counted are different events; the
  panel prompts the check-in instead.
- Any change to the items card, the line drawer, `CostTape`, or the page head.
- A Products tab — the items card stays where it is.
- Reworking the desktop Submit (create) page.
- Freezing tracking after the carrier's first scan (option C in the
  brainstorm) — one editability rule for the whole page instead.

## Notes

- Spec: `docs/superpowers/specs/2026-09-20-po-page-status-spine-design.md`.
- Ships as four PRs to `dev` (backend → shared frontend helpers + checkpoint →
  desktop page → phone), each with its own minor bump; `pr:` above lists them
  as they land.
- No migration: every column already exists (0126, 0094, 0106).
- Facts (`missingSource / missingDelivery / missingTracking / missingMethod`)
  are enforced at the hand-off only; `/advance` keeps the existing enforced
  set so legacy Drafts and manager stage-jumps are unaffected.
