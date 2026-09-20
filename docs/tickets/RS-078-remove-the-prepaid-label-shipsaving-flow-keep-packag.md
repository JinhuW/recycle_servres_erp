---
id: RS-078
title: Remove the prepaid-label (ShipSaving) flow; keep package tracking
type: chore
status: done
priority: P2
created: 2026-09-19
reporter: jinhu
branch: feat/remove-shipsaving
pr: 365
version: 1.157.0
related: [RS-013, RS-050, RS-075, RS-077]
---

## Ask

> clean up all save shipping related code. cuz i am not planning to create
> lables in the systm

## Context

ShipSaving was the prepaid-label provider (v1.68.0, v2 client in v1.79.0)
behind the `shipments` feature: get rates → buy label → void, a seller-fill
link (`/s/<token>`), a full-page label wizard, a per-PO *Shipping labels*
panel, and the label cost folded into `orders.other_fees`.  It never went
live — prod has always reported `labels: "stub"` on `/api/health` (RS-013)
because the ShipSaving portal keys were never issued for v2.  Every shipment
row ever written is a demo label.

Package *tracking* is a separate path that is live: an externally bought
tracking number is pasted into the In Transit hand-off (RS-050), Shippo
moves it (v1.102.0), and the PO shows the journey (RS-075, RS-077).  That
stays untouched.

Decisions (session 2026-09-19):

- Remove the whole label flow, not just the ShipSaving client — a stub-only
  label wizard is a feature nobody will use.
- Leave the `shipments` table and its migrations in place.  No schema change;
  the code simply stops reading and writing it.  A drop migration is a
  one-liner later if wanted.

## Acceptance criteria

- [x] `apps/backend/src/shipping/shipsaving.ts`, `routes/shipments.ts`,
      `routes/shipmentsGlobal.ts`, `routes/shippingPublic.ts`,
      `services/shipmentVoid.ts` are gone; `grep -rn shipments apps/*/src`
      returns nothing.
- [x] `SHIPSAVING_*` env vars are gone from `env.ts`, `types.ts`,
      `.env.example`.
- [x] `/api/health` `providers` reports `tracking` and `ocr` only.
- [x] `GET /api/packages/inbound-counts` serves the phone Dashboard card
      (packages only, same `moving` / `needs` buckets, same scoping).
- [x] The Shipping page (desktop `#/shipping`, phone inbound list) lists
      tracked packages only; *Add label* still works; the label wizard,
      per-PO shipping panel, seller portal and `Shipping labels` PO button
      no longer exist.
- [x] PO delete no longer refuses on purchased labels; PO detail no longer
      shows a shipment count or a label-cost split in the cost tape.
- [x] Package tracking is unchanged: Shippo webhook, 45-minute poll, PO
      In Transit journey, carrier link, ETA.
- [x] Backend and frontend suites green; `pnpm typecheck` clean; i18n
      coverage + parity tests pass with the orphaned keys removed.
- [x] `docs/FEATURES.md` Shipping section describes package tracking only and
      cites the removal version.

## Out of scope

- `warehouses.ship_*` + the Warehouses settings ship-to form: since 0109 the
  structured ship-to *is* the warehouse address, not a label-only field.
- Dropping the `shipments` table (owner chose to leave it).
- The `handoffMethod: 'label'` hand-off path — that is an external label,
  i.e. package tracking.

## Notes

- Plan: `~/.claude/plans/hashed-orbiting-lemon.md` (session file).
- Historical `shipment_*` rows in `order_events` render as their raw kind in
  the activity log once the renderer goes; prod has about one.
