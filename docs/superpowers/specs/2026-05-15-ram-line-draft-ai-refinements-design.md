# RAM Line Submission Refinements — Design

Date: 2026-05-15
Status: Approved (design)

## Summary

Seven refinements to the RAM line / order submission feature:

1. Restrict the RAM brand list.
2. Expand the RAM rank list to cover all module organizations.
3. Expand the RAM speed list to the full DDR3/DDR4/DDR5 range.
4. Move AI capture inline into the Add RAM line form; keep the captured image visible.
5. Always persist the in-progress order as a server-side draft; a line becomes a real
   inventory product only when the user Confirms it.
6. Add a guarded "Delete order" action (red button + typed order-ID confirmation).
7. Make the AI extractor honest: do not autofill when not confident.

## Context (current state)

- `POST /api/orders` already creates the order with `lifecycle: 'draft'` and each line with
  status `'Draft'` — but only when the *whole* order is submitted at the end. In-progress
  work is not persisted; nothing exists server-side until final submit.
- Catalog option lists (brand/rank/speed/etc.) are DB-backed in `catalog_options`, seeded
  from arrays in `apps/backend/scripts/seed.mjs`, loaded into the frontend at app boot via
  `lib/lookups.ts` / `lib/catalog.ts`.
- AI capture is a separate camera screen (`apps/frontend/src/pages/Camera.tsx`) that POSTs
  to `POST /api/scan/label`, stores the image in Cloudflare Images, audit-logs to
  `label_scans`, and returns `{ imageId, deliveryUrl, extracted, confidence, provider }`.
  The result is passed back into `SubmitForm` via `aiDefaults` / `aiPatch`.
- `aiPatch` / `aiDefaults` (`SubmitForm.tsx`) already only copy fields the extractor
  actually returned (truthy check). The stub extractor (`apps/backend/src/ai.ts`) always
  returns full canned data with ~0.85 confidence regardless of the image.
- No delete-order endpoint exists. Order/line lifecycle: `Draft → In Transit → Reviewing
  → Done`. `order_lines` rows ARE the inventory; there is no separate products table.
  `isSellable` = status is `Reviewing` or `Done`.

## Requirements & Design

### R1 — Brand list

Final RAM brand list: `['Samsung', 'SK Hynix', 'Micron', 'Kingston', 'Other']`.

- Change `RAM_BRANDS` in `apps/backend/scripts/seed.mjs` and reseed `catalog_options`
  (group `RAM_BRAND`).
- Existing `order_lines.brand` values that are no longer in the list (`Hynix`, `Crucial`,
  `Corsair`, etc.) are **left as-is**. Only new selections are restricted. No data
  migration.

### R2 — Rank list (complete)

`['1Rx16', '1Rx8', '1Rx4', '2Rx16', '2Rx8', '2Rx4', '4Rx8', '4Rx4', '8Rx4']`

Rationale — rank notation is `<#ranks>R x <DRAM device width in bits>`:
- x16 / x8 single & dual rank → UDIMM / SODIMM
- x8 / x4 → RDIMM
- 4Rx8, 4Rx4, 8Rx4 → LRDIMM / 3DS server modules

Change `RAM_RANK` in `seed.mjs`; reseed group `RAM_RANK`. Existing values left as-is.

### R3 — Speed list (complete)

Full DDR3/DDR4/DDR5 union, MT/s as strings:

`['800','1066','1333','1600','1866','2133','2400','2666','2933','3200','4000','4400','4800','5200','5600','6000','6400','6800','7200','7600','8000']`

Change `RAM_SPEED` in `seed.mjs`; reseed group `RAM_SPEED`. Existing values left as-is.

### R4 — Inline AI capture, image visible

- Remove the standalone camera step from the RAM add-line flow. Add an **"AI capture"**
  button inside the Add RAM line form (both `SubmitForm.tsx` mobile and the desktop
  `DesktopSubmit` line form).
- Pressing it opens the capture/upload affordance, POSTs to `POST /api/scan/label`
  (unchanged endpoint), and on success autofills the line fields subject to R7.
- After a successful scan the captured image is **shown** as a thumbnail in the line form,
  sourced from the returned `deliveryUrl` (already persisted in Cloudflare Images and
  referenced by `scanImageId`). Re-capture replaces it.
- The AI confidence banner behavior is governed by R7.

### R5 — Always-draft persistence; Confirm promotes a line to a product

Approach A (eager server draft).

- New endpoint `POST /api/orders/draft` → creates an order row with `lifecycle: 'draft'`
  and no lines (or with provided order meta), returns `{ id: 'SO-####' }`. Idempotent per
  in-progress session: the submit screen creates/reuses one draft id.
- Adding or editing a line autosaves it to DB as a `Draft`-status line via the existing
  `PATCH /api/orders/:id` line-upsert path (extended as needed to accept new/edited draft
  lines for a draft order). In-progress work is therefore never lost.
- **Confirm line**: a per-line action that promotes that line's status `Draft → In
  Transit`. A confirmed line is a real inventory product (no new table — `order_lines`
  rows already are inventory). Confirm persists any pending edits to that line first.
- The order keeps `lifecycle: 'draft'`. Its displayed status is derived from its lines as
  today (`Mixed` while some lines are still `Draft`; `In Transit` once all are confirmed).
  No change to the existing derived-status logic is required.
- Abandoned-draft cleanup: a draft order with zero lines older than a threshold (e.g. 24h)
  is eligible for deletion by a cleanup routine. (Implementation detail; can be a simple
  scheduled/manual sweep — not on the critical path for this feature.)
- `POST /api/orders` (whole-order create) remains for backward compatibility but the
  desktop/mobile submit flow now uses the draft + per-line-confirm path.

### R6 — Delete order (guarded)

- New endpoint `DELETE /api/orders/:id`:
  - Allowed only while the order's lifecycle is `draft` (Draft).
  - Allowed only for users who may edit the order (order owner / purchaser, or manager) —
    same authorization predicate the PATCH path uses.
  - Rejected with `409` if any line is referenced by a sell order
    (`sell_order_lines`), consistent with the existing line-removal guard.
  - On success deletes the order; `order_lines` cascade-delete via existing FK.
- Frontend: a red **"Delete order"** button on the order edit screen
  (`DesktopEditOrder` and the mobile equivalent), visible only when the order is a Draft
  and the user may edit it. Clicking opens a confirmation modal that requires typing the
  exact order ID (e.g. `SO-1342`); the Delete button in the modal is disabled until the
  typed value matches exactly.

### R7 — Honest AI extraction

- **Confidence floor.** Define a threshold (start at `0.6`). If the scan's overall
  `confidence` is below the floor, autofill **nothing** — the line stays blank for manual
  entry. Show a neutral message ("Couldn't read the label confidently — please enter the
  details manually") instead of the confidence banner.
- **No fabricated stub data.** The stub extractor must not return full canned specs at high
  confidence. Stub returns either an empty extraction at low confidence, or is gated so it
  does not masquerade as a confident real read. (Real `workers-ai` path already returns
  only fields present in the model output and a genuine confidence.)
- **Field-level honesty above the floor.** When confidence ≥ floor, keep the existing
  behavior of copying only fields the extractor actually returned (`aiPatch` /
  `aiDefaults` truthy checks); never invent values for missing fields — leave them blank.
- The model prompt's enumerations are widened to match R2/R3 (rank list, speed as a
  number) and R1 (brand list) so suggested values are consistent with the catalog.

## Components touched

- `apps/backend/scripts/seed.mjs` — RAM_BRANDS / RAM_RANK / RAM_SPEED arrays; reseed.
- `apps/backend/src/routes/orders.ts` — `POST /api/orders/draft`, extend `PATCH` for
  draft line autosave, per-line confirm transition, `DELETE /api/orders/:id`.
- `apps/backend/src/ai.ts` — confidence floor constant, stub honesty, prompt enum widening.
- `apps/backend/src/routes/scan.ts` — unchanged endpoint; confidence passthrough only.
- `apps/frontend/src/pages/SubmitForm.tsx` — inline AI capture button, image thumbnail,
  confidence-gated autofill, Confirm-line action.
- `apps/frontend/src/pages/Camera.tsx` — repurpose/inline (no standalone step in RAM flow).
- `apps/frontend/src/pages/desktop/DesktopSubmit.tsx` — inline AI capture, image, Confirm.
- `apps/frontend/src/pages/desktop/DesktopEditOrder.tsx` (+ mobile equiv) — red delete
  button + typed-ID confirmation modal; draft autosave wiring.
- `apps/frontend/src/lib/api.ts` — new draft/confirm/delete client calls.

## Error handling

- Draft create failure → block the submit screen with a retry; do not let the user add
  lines with no server draft.
- Line autosave failure → surface inline, keep local state, retry; do not silently drop.
- Confirm with validation errors → reject, keep line in `Draft`, show which fields fail.
- Delete: `409` if sold; `403` if not editable / not Draft; `404` if missing — each maps
  to a clear user message.

## Testing

- Backend: draft create; line autosave round-trip; confirm transitions `Draft →
  In Transit`; delete allowed only Draft + editor; delete `409` when line is sold;
  reseed produces the new brand/rank/speed option sets.
- AI: confidence below floor → empty extraction returned / nothing autofilled; stub does
  not return high-confidence canned data; above floor copies only present fields.
- Frontend: AI capture inline autofills only confident fields and shows the image;
  unconfident scan leaves form blank with manual-entry message; delete modal enables only
  on exact ID match; in-progress order survives reload (draft persisted).

## Out of scope

- Migrating existing non-conforming brand/rank/speed values.
- Changes to Reviewing/Done stages, pricing, or sell-order flow.
- A separate products table (explicitly rejected — order_lines are inventory).
